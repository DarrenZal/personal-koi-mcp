/**
 * KOI API Tools Module
 *
 * Implements all 15 KOI tool contract endpoints:
 * - 12 API-backed tools (entity resolution, search, web curation, federation)
 * - 3 local vault tools (read, write, list) with path traversal protection
 *
 * These tools wrap the KOI API at KOI_API_ENDPOINT (default: http://127.0.0.1:8351).
 * See: Octo/docs/koi-tool-contract.md
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import YAML from 'yaml';

// =============================================================================
// Client setup
// =============================================================================

let koiClient: any = null;

function getKoiClient(): any {
  if (!koiClient) {
    const baseURL = process.env.KOI_API_ENDPOINT || 'http://127.0.0.1:8351';
    koiClient = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return koiClient;
}

async function getKoiAdminAuthHeaders(): Promise<Record<string, string> | undefined> {
  let token = process.env.KOI_ADMIN_TOKEN;
  if (!token) {
    const home = process.env.HOME || '';
    const defaultStateDir = home ? path.join(home, '.config', 'personal-koi', 'koi-state') : '';
    const stateDir = process.env.KOI_STATE_DIR || defaultStateDir;
    if (stateDir) {
      const tokenPath = path.join(stateDir, 'admin_token');
      try {
        token = (await fs.readFile(tokenPath, 'utf-8')).trim();
      } catch {
        token = undefined;
      }
    }
  }
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

// =============================================================================
// Vault helpers (lazy — only fail when a vault tool is actually called)
// =============================================================================

function getVaultPath(): string {
  const p = process.env.VAULT_PATH;
  if (!p) throw new Error('VAULT_PATH environment variable must be set for vault tools');
  return p;
}

function safeVaultPath(relativePath: string): string {
  const vaultRoot = getVaultPath();
  const resolved = path.resolve(vaultRoot, relativePath);
  const normalizedVault = path.resolve(vaultRoot);
  if (!resolved.startsWith(normalizedVault + path.sep) && resolved !== normalizedVault) {
    throw new Error(`Path traversal rejected: "${relativePath}" resolves outside vault root`);
  }
  return resolved;
}

async function resolveToUri(client: any, nameOrUri: string): Promise<string> {
  if (nameOrUri.startsWith('orn:')) return nameOrUri;
  const { data } = await client.post('/entity/resolve', { label: nameOrUri });
  const candidates = data.candidates || [];
  if (candidates.length > 0 && candidates[0].confidence >= 0.5) {
    return candidates[0].uri;
  }
  throw new Error(`Could not resolve "${nameOrUri}" to a known entity`);
}

type ShareMode = 'root_only' | 'root_plus_required' | 'context_pack';
type RecipientType = 'peer' | 'commons';

type ShareLinkType = 'embed' | 'wikilink' | 'markdown_embed' | 'markdown_link' | 'frontmatter';

type ShareRef = {
  raw_target: string;
  link_type: ShareLinkType;
  required: boolean;
  source_path?: string;
  source_rid?: string;
  source_depth?: number;
  resolved_path?: string;
  ref_rid?: string;
  target_depth?: number;
  exists?: boolean;
  included?: boolean;
  include_reason?: string;
  skip_reason?: string;
};

type ShareDependencyDoc = {
  rid: string;
  vault_path: string;
  content: string;
  content_type: 'text/markdown';
  depth: number;
  required: boolean;
  parent_rid?: string;
  parent_path?: string;
};

type ShareGraphNode = {
  rid: string;
  vault_path: string;
  depth: number;
  included: boolean;
  role: 'root' | 'dependency';
};

type ShareGraphEdge = {
  source_rid: string;
  source_path: string;
  source_depth: number;
  raw_target: string;
  link_type: ShareLinkType;
  required: boolean;
  target_rid?: string;
  target_path?: string;
  target_depth?: number;
  exists: boolean;
  included: boolean;
  include_reason?: string;
  skip_reason?: string;
};

type ShareDependencyGraph = {
  max_depth_requested: number;
  max_depth_reached: number;
  nodes: ShareGraphNode[];
  edges: ShareGraphEdge[];
  missing_references: ShareGraphEdge[];
  summary: {
    total_references: number;
    resolved_references: number;
    unresolved_references: number;
    included_references: number;
    missing_references: number;
    required_missing: number;
    optional_missing: number;
    excluded_by_reason: Record<string, number>;
  };
};

const SHARE_MODES: ShareMode[] = ['root_only', 'root_plus_required', 'context_pack'];
const RECIPIENT_TYPES: RecipientType[] = ['peer', 'commons'];
const DEFAULT_OPTIONAL_LIMIT = 12;
const MAX_SHARE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONTEXT_DEPTH_CONTEXT_PACK = 2;
const DEFAULT_CONTEXT_DEPTH_OTHER = 1;
const MAX_CONTEXT_DEPTH = 4;

function parseContextDepth(raw: number | undefined, mode: ShareMode): number {
  if (raw === undefined || raw === null) {
    return mode === 'context_pack' ? DEFAULT_CONTEXT_DEPTH_CONTEXT_PACK : DEFAULT_CONTEXT_DEPTH_OTHER;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`context_depth must be an integer between 1 and ${MAX_CONTEXT_DEPTH}`);
  }
  if (n < 1 || n > MAX_CONTEXT_DEPTH) {
    throw new Error(`context_depth must be between 1 and ${MAX_CONTEXT_DEPTH}`);
  }
  return n;
}

function parseRecipientType(raw: string | undefined): RecipientType {
  const value = (raw || 'peer').trim().toLowerCase();
  if (!RECIPIENT_TYPES.includes(value as RecipientType)) {
    throw new Error(`recipient_type must be one of: ${RECIPIENT_TYPES.join(', ')}`);
  }
  return value as RecipientType;
}

function normalizeWikiTarget(raw: string): string {
  const withoutAlias = raw.split('|')[0] ?? raw;
  const withoutAnchor = withoutAlias.split('#')[0] ?? withoutAlias;
  return withoutAnchor.trim();
}

function toNoteRid(notePath: string): string {
  return `orn:obsidian.note:${notePath}`;
}

function stripFrontmatter(md: string): { body: string; frontmatter: Record<string, unknown> | null } {
  const match = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { body: md, frontmatter: null };
  try {
    return {
      body: md.slice(match[0].length),
      frontmatter: YAML.parse(match[1]) as Record<string, unknown>,
    };
  } catch {
    return { body: md.slice(match[0].length), frontmatter: null };
  }
}

function collectFrontmatterStringRefs(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Capture explicit wikilinks in frontmatter.
    const wikiMatches = [...trimmed.matchAll(/\[\[([^\]]+)\]\]/g)];
    if (wikiMatches.length > 0) {
      for (const m of wikiMatches) {
        const target = normalizeWikiTarget(m[1] ?? '');
        if (target) out.push(target);
      }
      return;
    }
    // Capture path-like references commonly used in metadata.
    if (trimmed.endsWith('.md') || trimmed.includes('/')) {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFrontmatterStringRefs(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectFrontmatterStringRefs(item, out);
    }
  }
}

function sanitizeLocalLinkTarget(raw: string): string | null {
  let target = raw.trim();
  if (!target) return null;

  if (target.startsWith('<') && target.endsWith('>') && target.length > 2) {
    target = target.slice(1, -1).trim();
  }

  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep raw target if URL-decoding fails.
  }

  // External URLs / mailto / anchors are references, but not local note dependencies.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null;
  if (target.startsWith('#')) return null;

  target = target.split('#')[0]?.split('?')[0]?.trim() || '';
  if (!target) return null;

  return target.replace(/\\/g, '/');
}

async function buildVaultMarkdownBasenameIndex(vaultRoot: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();

  async function walk(relDir: string): Promise<void> {
    const absDir = relDir ? path.join(vaultRoot, relDir) : vaultRoot;
    let entries: Array<import('node:fs').Dirent> = [];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

      const normalized = relPath.replace(/\\/g, '/');
      const key = path.basename(normalized).toLowerCase();
      const bucket = index.get(key) || [];
      bucket.push(normalized);
      index.set(key, bucket);
    }
  }

  await walk('');
  return index;
}

async function resolveLocalNoteTarget(
  sourceDocPath: string,
  rawTarget: string,
  basenameIndex: Map<string, string[]>
): Promise<{ resolvedPath?: string; exists: boolean }> {
  const sanitized = sanitizeLocalLinkTarget(rawTarget);
  if (!sanitized) return { exists: false };

  const hasExt = path.extname(sanitized) !== '';
  const relativeBase = sanitized.startsWith('/')
    ? sanitized.slice(1)
    : path.normalize(path.join(path.dirname(sourceDocPath), sanitized));

  const candidateSet = new Set<string>();
  if (hasExt) {
    candidateSet.add(relativeBase);
  } else {
    candidateSet.add(`${relativeBase}.md`);
  }

  // Obsidian-style fallback: [[Note Title]] can resolve by filename anywhere in the vault.
  if (!sanitized.includes('/') && !hasExt) {
    const key = `${sanitized.toLowerCase()}.md`;
    for (const rel of basenameIndex.get(key) || []) {
      candidateSet.add(rel);
    }
  }

  for (const candidateRaw of candidateSet) {
    const candidate = candidateRaw.replace(/\\/g, '/');
    let absolute = '';
    try {
      absolute = safeVaultPath(candidate);
    } catch {
      continue;
    }
    try {
      await fs.access(absolute);
      return { resolvedPath: candidate, exists: true };
    } catch {
      // Keep trying.
    }
  }

  return { exists: false };
}

function extractReferencesFromMarkdown(
  sourceDocPath: string,
  sourceDepth: number,
  markdown: string
): ShareRef[] {
  const { body, frontmatter } = stripFrontmatter(markdown);
  const refs: ShareRef[] = [];
  const sourceRid = toNoteRid(sourceDocPath);

  const appendRef = (rawTarget: string, linkType: ShareLinkType, required: boolean): void => {
    if (!rawTarget) return;
    refs.push({
      raw_target: rawTarget,
      link_type: linkType,
      required,
      source_path: sourceDocPath,
      source_rid: sourceRid,
      source_depth: sourceDepth,
    });
  };

  for (const m of body.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const target = normalizeWikiTarget(m[1] ?? '');
    appendRef(target, 'embed', true);
  }

  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const matchStart = m.index ?? 0;
    if (matchStart > 0 && body[matchStart - 1] === '!') continue;
    const target = normalizeWikiTarget(m[1] ?? '');
    appendRef(target, 'wikilink', false);
  }

  for (const m of body.matchAll(/(!?)\[[^\]]*]\(([^)]+)\)/g)) {
    const isEmbed = m[1] === '!';
    const target = sanitizeLocalLinkTarget(m[2] ?? '');
    if (!target) continue;
    appendRef(target, isEmbed ? 'markdown_embed' : 'markdown_link', isEmbed);
  }

  const fmRefs: string[] = [];
  if (frontmatter) collectFrontmatterStringRefs(frontmatter, fmRefs);
  for (const target of fmRefs) {
    appendRef(target, 'frontmatter', false);
  }

  const dedup = new Map<string, ShareRef>();
  for (const ref of refs) {
    const key = `${(ref.source_path || '').toLowerCase()}:${ref.link_type}:${ref.raw_target.toLowerCase()}`;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, ref);
      continue;
    }
    existing.required = existing.required || ref.required;
  }

  return [...dedup.values()];
}

async function buildSharePayload(
  docPath: string,
  mode: ShareMode,
  optionalLimit: number,
  contextDepth: number
): Promise<{ contents: Record<string, unknown>; references: ShareRef[]; dependencyGraph: ShareDependencyGraph }> {
  const normalizedDocPath = docPath.replace(/\\/g, '/');
  const rootFullPath = safeVaultPath(normalizedDocPath);
  const rootMarkdown = await fs.readFile(rootFullPath, 'utf-8');
  const basenameIndex = await buildVaultMarkdownBasenameIndex(getVaultPath());

  const docContentCache = new Map<string, string>();
  docContentCache.set(normalizedDocPath, rootMarkdown);

  const getDocContent = async (docPathRel: string): Promise<string> => {
    const cached = docContentCache.get(docPathRel);
    if (cached !== undefined) return cached;
    const abs = safeVaultPath(docPathRel);
    const content = await fs.readFile(abs, 'utf-8');
    docContentCache.set(docPathRel, content);
    return content;
  };

  const allRefs: ShareRef[] = [];
  const dependencyDocs: ShareDependencyDoc[] = [];
  const graphEdges: ShareGraphEdge[] = [];
  const graphNodes = new Map<string, ShareGraphNode>();
  const includedPaths = new Set<string>();
  const processedPaths = new Set<string>();
  const queuedPaths = new Set<string>();
  const traversalQueue: Array<{ docPath: string; depth: number; parentPath?: string; parentRid?: string }> = [];

  graphNodes.set(normalizedDocPath, {
    rid: toNoteRid(normalizedDocPath),
    vault_path: normalizedDocPath,
    depth: 0,
    included: true,
    role: 'root',
  });
  traversalQueue.push({ docPath: normalizedDocPath, depth: 0 });
  queuedPaths.add(normalizedDocPath);

  let optionalIncluded = 0;
  let currentBytes = Buffer.byteLength(rootMarkdown, 'utf-8');
  let maxDepthReached = 0;

  const addGraphNode = (docPathRel: string, depth: number, included: boolean): void => {
    const rid = toNoteRid(docPathRel);
    const existing = graphNodes.get(docPathRel);
    if (!existing) {
      graphNodes.set(docPathRel, {
        rid,
        vault_path: docPathRel,
        depth,
        included,
        role: docPathRel === normalizedDocPath ? 'root' : 'dependency',
      });
      return;
    }
    if (depth < existing.depth) existing.depth = depth;
    if (included) existing.included = true;
  };

  while (traversalQueue.length > 0) {
    const current = traversalQueue.shift()!;
    if (processedPaths.has(current.docPath)) continue;
    processedPaths.add(current.docPath);
    if (current.depth > maxDepthReached) maxDepthReached = current.depth;

    let sourceMarkdown = '';
    try {
      sourceMarkdown = await getDocContent(current.docPath);
    } catch {
      continue;
    }

    const refs = extractReferencesFromMarkdown(current.docPath, current.depth, sourceMarkdown);
    for (const ref of refs) {
      const resolved = await resolveLocalNoteTarget(current.docPath, ref.raw_target, basenameIndex);
      if (resolved.exists && resolved.resolvedPath && resolved.resolvedPath.toLowerCase().endsWith('.md')) {
        ref.exists = true;
        ref.resolved_path = resolved.resolvedPath;
        ref.ref_rid = toNoteRid(resolved.resolvedPath);
        ref.target_depth = current.depth + 1;
        addGraphNode(resolved.resolvedPath, current.depth + 1, false);
      } else {
        ref.exists = false;
      }

      const modeAllowsInclude = (() => {
        if (mode === 'root_only') return false;
        if (mode === 'root_plus_required') return ref.required;
        if (ref.required) return true;
        return optionalIncluded < optionalLimit;
      })();

      if (!modeAllowsInclude) {
        ref.included = false;
        ref.skip_reason = mode === 'context_pack' && !ref.required ? 'optional_limit' : 'mode';
      } else if (!ref.exists || !ref.resolved_path || !ref.ref_rid) {
        ref.included = false;
        ref.skip_reason = 'unresolved';
      } else if (includedPaths.has(ref.resolved_path)) {
        ref.included = true;
        ref.include_reason = 'dedup';
      } else {
        try {
          const depContent = await getDocContent(ref.resolved_path);
          const depBytes = Buffer.byteLength(depContent, 'utf-8');
          if (currentBytes + depBytes > MAX_SHARE_PAYLOAD_BYTES) {
            ref.included = false;
            ref.skip_reason = 'payload_limit';
          } else {
            currentBytes += depBytes;
            includedPaths.add(ref.resolved_path);
            if (!ref.required) optionalIncluded += 1;

            dependencyDocs.push({
              rid: ref.ref_rid,
              vault_path: ref.resolved_path,
              content: depContent,
              content_type: 'text/markdown',
              depth: current.depth + 1,
              required: ref.required,
              parent_rid: ref.source_rid,
              parent_path: ref.source_path,
            });
            ref.included = true;
            ref.include_reason = ref.required ? 'required_reference' : 'context_pack_optional';
            addGraphNode(ref.resolved_path, current.depth + 1, true);

            const shouldTraverse = contextDepth > current.depth + 1;
            if (shouldTraverse && !queuedPaths.has(ref.resolved_path)) {
              traversalQueue.push({
                docPath: ref.resolved_path,
                depth: current.depth + 1,
                parentPath: ref.source_path,
                parentRid: ref.source_rid,
              });
              queuedPaths.add(ref.resolved_path);
            }
          }
        } catch {
          ref.included = false;
          ref.skip_reason = 'read_failed';
        }
      }

      allRefs.push(ref);
      graphEdges.push({
        source_rid: ref.source_rid || toNoteRid(current.docPath),
        source_path: ref.source_path || current.docPath,
        source_depth: ref.source_depth ?? current.depth,
        raw_target: ref.raw_target,
        link_type: ref.link_type,
        required: ref.required,
        target_rid: ref.ref_rid,
        target_path: ref.resolved_path,
        target_depth: ref.target_depth,
        exists: Boolean(ref.exists),
        included: Boolean(ref.included),
        include_reason: ref.include_reason,
        skip_reason: ref.skip_reason,
      });
    }
  }

  const missingReferences = graphEdges.filter((edge) => !edge.exists || !edge.included);
  const excludedByReason: Record<string, number> = {};
  for (const edge of missingReferences) {
    const reason = edge.skip_reason || (!edge.exists ? 'unresolved' : 'excluded');
    excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
  }

  const dependencyGraph: ShareDependencyGraph = {
    max_depth_requested: contextDepth,
    max_depth_reached: maxDepthReached,
    nodes: [...graphNodes.values()].sort((a, b) => a.depth - b.depth || a.vault_path.localeCompare(b.vault_path)),
    edges: graphEdges,
    missing_references: missingReferences,
    summary: {
      total_references: graphEdges.length,
      resolved_references: graphEdges.filter((edge) => edge.exists).length,
      unresolved_references: graphEdges.filter((edge) => !edge.exists).length,
      included_references: graphEdges.filter((edge) => edge.included).length,
      missing_references: missingReferences.length,
      required_missing: missingReferences.filter((edge) => edge.required).length,
      optional_missing: missingReferences.filter((edge) => !edge.required).length,
      excluded_by_reason: excludedByReason,
    },
  };

  return {
    contents: {
      vault_path: normalizedDocPath,
      content: rootMarkdown,
      content_type: 'text/markdown',
      share_mode: mode,
      context_depth: contextDepth,
      references: allRefs,
      dependencies: dependencyDocs,
      dependency_count: dependencyDocs.length,
      dependency_graph: dependencyGraph,
    },
    references: allRefs,
    dependencyGraph,
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

export const KOI_API_TOOL_DEFINITIONS: Tool[] = [
  // --- 3 Entity tools (contract-aligned, replacing Regen-oriented handlers) ---
  {
    name: 'resolve_entity',
    description:
      'Resolve an entity name to its canonical form in the knowledge graph. Use this when someone mentions a person, organization, project, or concept by name. Returns the best match with type, URI, and confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: "The entity name or label to resolve (e.g. 'Bill', 'r3.0', 'pattern mining')",
        },
        type_hint: {
          type: 'string',
          description: 'Optional type hint: Person, Organization, Project, Concept, Location, Meeting',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'get_entity_neighborhood',
    description:
      "Get the neighborhood of an entity in the knowledge graph — its relationships, affiliated organizations, projects, and connected people. Use when asked 'who works with X?' or 'what is Y involved in?'",
    inputSchema: {
      type: 'object',
      properties: {
        entity_uri: {
          type: 'string',
          description: "The entity URI or name (e.g. 'bill-baue', 'r3.0')",
        },
      },
      required: ['entity_uri'],
    },
  },
  {
    name: 'get_entity_documents',
    description:
      "Find all documents that mention a specific entity. Use when asked 'what documents mention X?' or 'where is Y referenced?'",
    inputSchema: {
      type: 'object',
      properties: {
        entity_uri: { type: 'string', description: 'The entity URI or name' },
      },
      required: ['entity_uri'],
    },
  },
  // --- 3 Vault tools (contract-aligned, with path traversal guard) ---
  {
    name: 'vault_read_note',
    description:
      "Read a structured entity note from the bioregional knowledge vault. Notes are in folders: People/, Organizations/, Projects/, Concepts/, Bioregions/",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Relative path within the vault (e.g. 'People/Bill Baue.md')" },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_write_note',
    description:
      'Create or update an entity note in the bioregional knowledge vault. Use when learning about new entities. Include proper frontmatter with @type.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Relative path (e.g. 'People/New Person.md')" },
        content: { type: 'string', description: 'Full markdown content including YAML frontmatter' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'vault_list_notes',
    description:
      'List entity notes in a vault folder. Folders: People, Organizations, Projects, Concepts, Bioregions',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: "Folder name (e.g. 'People', 'Organizations')" },
      },
      required: ['folder'],
    },
  },
  // --- 9 API tools ---
  {
    name: 'koi_search',
    description:
      'Search the bioregional knowledge graph using semantic similarity. Returns entities matching the query. For document-level search, use knowledge_search instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        type_filter: {
          type: 'string',
          description: 'Optional: filter by entity type (Person, Organization, Project, Concept)',
        },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_search',
    description:
      'Search indexed documents using semantic similarity (RAG). Searches over koi_memories — GitHub code files, docs, markdown, configs — using embeddings. Returns document-level and chunk-level results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query or keywords' },
        source: { type: 'string', description: "Optional: filter by source ('github', 'vault', 'email')" },
        limit: { type: 'number', description: 'Max results (default 10)' },
        include_chunks: {
          type: 'boolean',
          description: 'Include chunk-level results (default true)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'preview_url',
    description:
      'Fetch and preview a URL for evaluation. Returns title, content summary, detected entities, and safety check. Does NOT ingest.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to preview' },
        submitted_by: { type: 'string', description: 'Username who shared the URL' },
        submitted_via: { type: 'string', description: 'Channel: telegram, discord, or api' },
      },
      required: ['url'],
    },
  },
  {
    name: 'process_url',
    description:
      'Extract entities/relationships from a previewed URL using server-side LLM. Call AFTER preview_url and BEFORE ingest_url.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to process (must be previewed first)' },
        hint_entities: {
          type: 'array',
          description: 'Optional: entity names to help the LLM match',
          items: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'ingest_url',
    description:
      'Ingest a previously previewed URL into the knowledge graph. Call AFTER preview_url. Pass entities and relationships identified from the preview.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to ingest (must be previewed first)' },
        entities: {
          type: 'array',
          description: 'Entities to resolve and link',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', description: 'Person, Organization, Project, Concept, Location, etc.' },
              context: { type: 'string', description: 'How this entity relates' },
            },
            required: ['name', 'type'],
          },
        },
        relationships: {
          type: 'array',
          description: 'Relationships between entities',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              predicate: { type: 'string' },
              object: { type: 'string' },
            },
            required: ['subject', 'predicate', 'object'],
          },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'github_scan',
    description: 'Trigger a GitHub repository scan or check sensor status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: "Action: 'scan' to trigger scan, 'status' to check (default: status)",
        },
        repo_name: {
          type: 'string',
          description: "Optional: specific repo to scan (e.g., 'DarrenZal/Octo')",
        },
      },
    },
  },
  {
    name: 'monitor_url',
    description: 'Manage web source monitoring. Add URLs for periodic change detection and re-extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: "Action: 'add', 'remove', or 'status' (default: status)",
        },
        url: { type: 'string', description: 'URL to add/remove from monitoring' },
        title: { type: 'string', description: 'Optional title for the source (used when adding)' },
      },
    },
  },
  {
    name: 'code_query',
    description:
      'Query the code knowledge graph using Cypher. The graph contains Functions, Classes, Modules, Files, Imports, and Interfaces with CALLS, CONTAINS, BELONGS_TO relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        cypher: {
          type: 'string',
          description: 'Cypher query to execute against the code knowledge graph',
        },
      },
      required: ['cypher'],
    },
  },
  {
    name: 'federation_status',
    description:
      'Get KOI-net federation status: node identity, connected peers, event queue size, and protocol policy.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'share_document',
    description:
      'Share a document via KOI-net federation. Supports recipient_type=peer|commons and rich-share modes: root_only, root_plus_required, context_pack.',
    inputSchema: {
      type: 'object',
      properties: {
        document_path: {
          type: 'string',
          description:
            'Path to the document in the vault (e.g. "Articles/My Research.md" or "projects/koi-protocol-comparison.md")',
        },
        recipient: {
          type: 'string',
          description:
            'Human-friendly name or alias of the recipient node (e.g. "shawn", "cowichan"). Must match a registered peer alias or node name.',
        },
        recipient_type: {
          type: 'string',
          description:
            'Recipient mode: peer (default) or commons. commons requests staged intake on the receiving commons node.',
        },
        message: {
          type: 'string',
          description: 'Optional message to include with the share (e.g. "Check this out — relevant to our project")',
        },
        mode: {
          type: 'string',
          description:
            'Share mode: root_only (only selected doc), root_plus_required (doc + required embeds/transclusions), context_pack (doc + required + optional references)',
        },
        optional_limit: {
          type: 'number',
          description:
            'When mode=context_pack, maximum number of optional referenced notes to include (default: 12)',
        },
        context_depth: {
          type: 'number',
          description:
            'Depth for dependency traversal when building context packs (integer 1-4). Default: 2 for context_pack, otherwise 1.',
        },
      },
      required: ['document_path', 'recipient'],
    },
  },
  {
    name: 'shared_with_me',
    description:
      'List documents shared with you by peers via KOI-net federation. Shows received documents with sender info and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO date string to filter documents received after this time (e.g. "2026-02-23")',
        },
        from_peer: {
          type: 'string',
          description: 'Filter by sender name or alias (e.g. "shawn")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 50)',
        },
      },
    },
  },
  {
    name: 'commons_intake',
    description:
      'List staged/approved/rejected commons intake records on this node. Requires KOI commons intake migration.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: "Filter by intake status: staged (default), approved, rejected, or all",
        },
        from_peer: {
          type: 'string',
          description: 'Filter by sender name or alias',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 50)',
        },
      },
    },
  },
  {
    name: 'commons_intake_decide',
    description:
      'Approve or reject a staged commons intake item (localhost admin auth enforced by KOI API).',
    inputSchema: {
      type: 'object',
      properties: {
        share_id: {
          type: 'number',
          description: 'Local intake record id (preferred)',
        },
        event_id: {
          type: 'string',
          description: 'Fallback identifier if share_id is unknown',
        },
        action: {
          type: 'string',
          description: 'Decision action: approve or reject',
        },
        reviewer: {
          type: 'string',
          description: 'Optional reviewer name',
        },
        note: {
          type: 'string',
          description: 'Optional decision note',
        },
      },
      required: ['action'],
    },
  },
];

// =============================================================================
// Tool Handlers
// =============================================================================

export async function handleKoiApiTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const client = getKoiClient();

  try {
    switch (toolName) {
      // --- 3 Entity tools (contract-aligned) ---
      case 'resolve_entity': {
        const label = args.label as string;
        const type_hint = args.type_hint as string | undefined;
        const { data } = await client.post('/entity/resolve', {
          label,
          type_hint: type_hint || undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_entity_neighborhood': {
        const input = args.entity_uri as string;
        const uri = await resolveToUri(client, input);
        const { data } = await client.get(`/relationships/${encodeURIComponent(uri)}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_entity_documents': {
        const input = args.entity_uri as string;
        const uri = await resolveToUri(client, input);
        const { data } = await client.get(`/entity/${encodeURIComponent(uri)}/mentioned-in`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      // --- 3 Vault tools (contract-aligned, with traversal guard) ---
      case 'vault_read_note': {
        const notePath = args.path as string;
        try {
          const fullPath = safeVaultPath(notePath);
          const content = await fs.readFile(fullPath, 'utf-8');
          return { content: [{ type: 'text', text: content }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Error reading ${notePath}: ${e.message}` }], isError: true };
        }
      }

      case 'vault_write_note': {
        const notePath = args.path as string;
        const noteContent = args.content as string;
        try {
          const fullPath = safeVaultPath(notePath);
          const dir = path.dirname(fullPath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(fullPath, noteContent, 'utf-8');
          return { content: [{ type: 'text', text: `Written: ${notePath}` }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Error writing ${notePath}: ${e.message}` }], isError: true };
        }
      }

      case 'vault_list_notes': {
        const folder = args.folder as string;
        try {
          const fullPath = safeVaultPath(folder);
          const files = await fs.readdir(fullPath);
          const mdFiles = files.filter((f: string) => f.endsWith('.md'));
          return { content: [{ type: 'text', text: mdFiles.join('\n') }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Error listing ${folder}: ${e.message}` }], isError: true };
        }
      }

      // --- 9 API tools ---
      case 'koi_search': {
        const query = args.query as string;
        const type_filter = args.type_filter as string | undefined;
        const limit = (args.limit as number) || 10;
        const params: Record<string, string> = { query, limit: String(limit) };
        if (type_filter) params.type_filter = type_filter;
        const { data } = await client.get('/entity-search', { params });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'knowledge_search': {
        const body: Record<string, unknown> = {
          query: args.query,
          limit: (args.limit as number) || 10,
          include_chunks: args.include_chunks !== false,
        };
        if (args.source) body.source = args.source;
        const { data } = await client.post('/search', body);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'preview_url': {
        const { data } = await client.post('/web/preview', {
          url: args.url,
          submitted_by: args.submitted_by,
          submitted_via: (args.submitted_via as string) || 'api',
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'process_url': {
        const { data } = await client.post('/web/process', {
          url: args.url,
          hint_entities: (args.hint_entities as string[]) || [],
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'ingest_url': {
        const { data } = await client.post('/web/ingest', {
          url: args.url,
          entities: (args.entities as any[]) || [],
          relationships: (args.relationships as any[]) || [],
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'github_scan': {
        const action = (args.action as string) || 'status';
        if (action === 'scan') {
          const params: Record<string, string> = {};
          if (args.repo_name) params.repo_name = args.repo_name as string;
          const { data } = await client.post('/github/scan', null, { params });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        const { data } = await client.get('/github/status');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'monitor_url': {
        const action = (args.action as string) || 'status';
        if (action === 'add') {
          const { data } = await client.post('/web/monitor/add', {
            url: args.url,
            title: args.title || '',
          });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        if (action === 'remove') {
          const { data } = await client.post('/web/monitor/remove', { url: args.url });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        const { data } = await client.get('/web/monitor/status');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'code_query': {
        const { data } = await client.post('/code/query', { cypher: args.cypher });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'federation_status': {
        const { data } = await client.get('/koi-net/health');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'share_document': {
        const docPath = args.document_path as string;
        const recipient = args.recipient as string;
        const message = args.message as string | undefined;
        let recipientType: RecipientType = 'peer';
        try {
          recipientType = parseRecipientType(args.recipient_type as string | undefined);
        } catch (recipientErr: any) {
          return {
            content: [{
              type: 'text',
              text: recipientErr?.message || 'Invalid recipient_type',
            }],
            isError: true,
          };
        }
        const modeInput = ((args.mode as string | undefined) || 'root_plus_required').trim().toLowerCase();
        if (!SHARE_MODES.includes(modeInput as ShareMode)) {
          return {
            content: [{
              type: 'text',
              text: `Invalid mode '${modeInput}'. Valid modes: ${SHARE_MODES.join(', ')}`,
            }],
            isError: true,
          };
        }
        const shareMode = modeInput as ShareMode;
        const optionalLimitRaw = args.optional_limit as number | undefined;
        const optionalLimit = Number.isFinite(optionalLimitRaw as number)
          ? Math.max(0, Number(optionalLimitRaw))
          : DEFAULT_OPTIONAL_LIMIT;
        let contextDepth = 1;
        try {
          contextDepth = parseContextDepth(args.context_depth as number | undefined, shareMode);
        } catch (depthErr: any) {
          return {
            content: [{
              type: 'text',
              text: depthErr?.message || 'Invalid context_depth',
            }],
            isError: true,
          };
        }

        // Build rich share payload from vault document and references
        let contents: Record<string, unknown> | undefined;
        let references: ShareRef[] | undefined;
        try {
          const built = await buildSharePayload(docPath, shareMode, optionalLimit, contextDepth);
          contents = built.contents;
          references = built.references;
        } catch {
          // If vault read fails, share without contents (metadata only).
        }

        const rid = `orn:obsidian.note:${docPath}`;
        const { data } = await client.post('/koi-net/share', {
          document_rid: rid,
          recipient,
          recipient_type: recipientType,
          message,
          share_mode: shareMode,
          context_depth: contextDepth,
          references,
          contents,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'shared_with_me': {
        const params = new URLSearchParams();
        if (args.since) params.set('since', args.since as string);
        if (args.from_peer) params.set('from_peer', args.from_peer as string);
        if (args.limit) params.set('limit', String(args.limit));
        const qs = params.toString();
        const { data } = await client.get(`/koi-net/shared-with-me${qs ? '?' + qs : ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'commons_intake': {
        const params = new URLSearchParams();
        if (args.status) params.set('status', args.status as string);
        if (args.from_peer) params.set('from_peer', args.from_peer as string);
        if (args.limit) params.set('limit', String(args.limit));
        const qs = params.toString();
        const { data } = await client.get(`/koi-net/commons/intake${qs ? '?' + qs : ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'commons_intake_decide': {
        const body: Record<string, unknown> = {
          action: args.action,
        };
        if (args.share_id !== undefined) body.share_id = args.share_id;
        if (args.event_id) body.event_id = args.event_id;
        if (args.reviewer) body.reviewer = args.reviewer;
        if (args.note) body.note = args.note;

        const headers = await getKoiAdminAuthHeaders();
        const { data } = await client.post(
          '/koi-net/commons/intake/decide',
          body,
          headers ? { headers } : undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown KOI API tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `KOI API error (${toolName}): ${msg}` }],
      isError: true,
    };
  }
}

/** Names of all KOI API tools handled by this module */
export const KOI_API_TOOL_NAMES = new Set(KOI_API_TOOL_DEFINITIONS.map((t) => t.name));
