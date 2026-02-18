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
