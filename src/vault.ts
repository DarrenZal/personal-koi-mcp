/**
 * Obsidian Vault Operations
 *
 * Local file operations for reading/writing to Obsidian vault
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { getEntityTypes, folderToTypeSync, getAllEntityFoldersSync, prefetchEntityTypes } from './entity-schema.js';

// Default vault path - can be overridden with OBSIDIAN_VAULT_PATH env var
const DEFAULT_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ||
  path.join(process.env.HOME || '', 'Documents', 'Notes');

// Excluded folders
const EXCLUDED_FOLDERS = new Set(['.obsidian', '.trash', '.smart-env', '.claude', 'Templates']);

interface ParsedNote {
  frontmatter: Record<string, any> | null;
  body: string;
  wikilinks: string[];
  entityType: string | null;
  entityId: string | null;
}

interface NoteInfo {
  path: string;
  name: string;
  entityType: string | null;
  frontmatter: Record<string, any> | null;
  modifiedAt: string;
}

export interface VaultEntityInfo {
  name: string;
  type: string;
  path: string;
  aliases: string[];
}

/**
 * Get the vault path, validating it exists
 */
export function getVaultPath(): string {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
  return vaultPath;
}

/**
 * Check if a path should be excluded
 */
function shouldExclude(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some(part => EXCLUDED_FOLDERS.has(part));
}

/**
 * Parse YAML frontmatter from note content
 */
export function parseFrontmatter(content: string): ParsedNote {
  const result: ParsedNote = {
    frontmatter: null,
    body: content,
    wikilinks: [],
    entityType: null,
    entityId: null
  };

  // Match frontmatter
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (match) {
    try {
      // Pre-process YAML to quote @ keys (common in Obsidian for schema.org)
      let yamlText = match[1];
      // Quote unquoted @-prefixed keys: @id: -> "@id":
      yamlText = yamlText.replace(/^(@\w+):/gm, '"$1":');

      result.frontmatter = yaml.parse(yamlText);
      result.body = content.slice(match[0].length).trim();

      if (result.frontmatter) {
        // Extract entity type
        const entityType = result.frontmatter['@type'] || result.frontmatter['type'];
        if (entityType) {
          result.entityType = entityType.replace('schema:', '');
        }

        // Extract entity ID
        const entityId = result.frontmatter['@id'] || result.frontmatter['id'];
        if (entityId) {
          result.entityId = entityId;
        } else if (result.frontmatter['name']) {
          result.entityId = result.frontmatter['name'].toLowerCase().replace(/\s+/g, '-');
        }
      }
    } catch (e) {
      // Invalid YAML, ignore
    }
  }

  // Extract wikilinks
  const wikilinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let wikilinkMatch;
  while ((wikilinkMatch = wikilinkPattern.exec(content)) !== null) {
    result.wikilinks.push(wikilinkMatch[1]);
  }

  return result;
}

/**
 * Generate YAML frontmatter string from object
 */
export function generateFrontmatter(data: Record<string, any>): string {
  return `---\n${yaml.stringify(data)}---\n`;
}

/**
 * Read a note from the vault
 */
export async function readNote(notePath: string): Promise<{
  content: string;
  parsed: ParsedNote;
  path: string;
  exists: boolean;
}> {
  const vaultPath = getVaultPath();

  // Normalize path - add .md if missing
  let fullPath = notePath;
  if (!path.isAbsolute(notePath)) {
    fullPath = path.join(vaultPath, notePath);
  }
  if (!fullPath.endsWith('.md')) {
    fullPath += '.md';
  }

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const parsed = parseFrontmatter(content);
    return {
      content,
      parsed,
      path: fullPath,
      exists: true
    };
  } catch (e) {
    return {
      content: '',
      parsed: {
        frontmatter: null,
        body: '',
        wikilinks: [],
        entityType: null,
        entityId: null
      },
      path: fullPath,
      exists: false
    };
  }
}

/**
 * Write a note to the vault
 */
export async function writeNote(
  notePath: string,
  content: string,
  frontmatter?: Record<string, any>
): Promise<{ success: boolean; path: string; error?: string }> {
  const vaultPath = getVaultPath();

  // Normalize path
  let fullPath = notePath;
  if (!path.isAbsolute(notePath)) {
    fullPath = path.join(vaultPath, notePath);
  }
  if (!fullPath.endsWith('.md')) {
    fullPath += '.md';
  }

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // Directory might already exist
  }

  // Build content
  let finalContent = content;
  if (frontmatter) {
    const fm = generateFrontmatter(frontmatter);
    // Check if content already has frontmatter
    if (content.startsWith('---')) {
      // Replace existing frontmatter
      finalContent = content.replace(/^---\s*\n[\s\S]*?\n---\n?/, fm);
    } else {
      finalContent = fm + '\n' + content;
    }
  }

  try {
    await fs.writeFile(fullPath, finalContent, 'utf-8');
    return { success: true, path: fullPath };
  } catch (e: any) {
    return { success: false, path: fullPath, error: e.message };
  }
}

/**
 * List notes in the vault, optionally filtered by type or folder
 */
export async function listNotes(options: {
  folder?: string;
  entityType?: string;
  limit?: number;
}): Promise<NoteInfo[]> {
  const vaultPath = getVaultPath();
  const searchPath = options.folder
    ? path.join(vaultPath, options.folder)
    : vaultPath;

  const results: NoteInfo[] = [];
  const limit = options.limit || 100;

  async function scanDir(dir: string): Promise<void> {
    if (results.length >= limit) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= limit) break;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(vaultPath, fullPath);

        if (shouldExclude(relativePath)) continue;

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const parsed = parseFrontmatter(content);

            // Filter by entity type if specified
            if (options.entityType && parsed.entityType !== options.entityType) {
              continue;
            }

            const stats = await fs.stat(fullPath);

            results.push({
              path: relativePath,
              name: entry.name.replace('.md', ''),
              entityType: parsed.entityType,
              frontmatter: parsed.frontmatter,
              modifiedAt: stats.mtime.toISOString()
            });
          } catch (e) {
            // Skip files we can't read
          }
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }
  }

  await scanDir(searchPath);
  return results;
}

/**
 * Search notes in the vault
 */
export async function searchNotes(options: {
  query: string;
  entityType?: string;
  searchContent?: boolean;
  limit?: number;
}): Promise<NoteInfo[]> {
  const allNotes = await listNotes({
    entityType: options.entityType,
    limit: 500 // Get more to search through
  });

  const query = options.query.toLowerCase();
  const searchContent = options.searchContent ?? true;
  const limit = options.limit || 20;

  const results: NoteInfo[] = [];
  const vaultPath = getVaultPath();

  for (const note of allNotes) {
    if (results.length >= limit) break;

    // Search in name
    if (note.name.toLowerCase().includes(query)) {
      results.push(note);
      continue;
    }

    // Search in frontmatter
    if (note.frontmatter) {
      const fmString = JSON.stringify(note.frontmatter).toLowerCase();
      if (fmString.includes(query)) {
        results.push(note);
        continue;
      }
    }

    // Search in content
    if (searchContent) {
      try {
        const content = await fs.readFile(
          path.join(vaultPath, note.path),
          'utf-8'
        );
        if (content.toLowerCase().includes(query)) {
          results.push(note);
        }
      } catch (e) {
        // Skip
      }
    }
  }

  return results;
}

/**
 * Get a note by entity type and name (for quick lookup)
 */
export async function getNoteByEntity(
  entityType: string,
  name: string
): Promise<{ found: boolean; path?: string; content?: string; parsed?: ParsedNote }> {
  // Try common paths
  const possiblePaths = [
    `${entityType}/${name}`,
    `${entityType}s/${name}`,  // Plural folder
    name,  // Root
    `People/${name}`,
    `Organizations/${name}`,
    `Meetings/${name}`,
    `Projects/${name}`
  ];

  for (const notePath of possiblePaths) {
    const result = await readNote(notePath);
    if (result.exists) {
      // Verify entity type if specified
      if (entityType && result.parsed.entityType &&
          result.parsed.entityType.toLowerCase() !== entityType.toLowerCase()) {
        continue;
      }
      return {
        found: true,
        path: result.path,
        content: result.content,
        parsed: result.parsed
      };
    }
  }

  return { found: false };
}

/**
 * Build an index of all entities in the vault
 * Scans entity folders dynamically from schema configuration
 */
export async function buildEntityIndex(): Promise<VaultEntityInfo[]> {
  const entities: VaultEntityInfo[] = [];
  const vaultPath = getVaultPath();

  // Prefetch entity types to populate sync maps
  await prefetchEntityTypes();

  // Get entity folders from schema (dynamic, not hardcoded)
  const schemaTypes = await getEntityTypes();
  const entityFolders = schemaTypes.map(t => ({
    folder: t.folder,
    type: t.type_key
  }));

  for (const { folder, type } of entityFolders) {
    const folderPath = path.join(vaultPath, folder);

    try {
      const entries = await fs.readdir(folderPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
          continue;
        }

        const filePath = path.join(folderPath, entry.name);
        const relativePath = path.relative(vaultPath, filePath).replace(/\.md$/, '');
        const name = entry.name.replace(/\.md$/, '');

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = parseFrontmatter(content);

          // Get aliases from frontmatter
          const aliases: string[] = [];
          if (parsed.frontmatter) {
            if (Array.isArray(parsed.frontmatter.aliases)) {
              aliases.push(...parsed.frontmatter.aliases);
            }
            if (parsed.frontmatter.alias) {
              aliases.push(parsed.frontmatter.alias);
            }
            // Also check for abbreviation/acronym
            if (parsed.frontmatter.abbreviation) {
              aliases.push(parsed.frontmatter.abbreviation);
            }
            if (parsed.frontmatter.acronym) {
              aliases.push(parsed.frontmatter.acronym);
            }
          }

          // Determine actual type (prefer frontmatter @type over folder inference)
          const entityType = parsed.entityType || type;

          entities.push({
            name,
            type: entityType,
            path: relativePath,
            aliases
          });
        } catch (e) {
          // Skip files we can't read
        }
      }
    } catch (e) {
      // Folder might not exist, skip it
    }
  }

  return entities;
}

/**
 * Find notes that link TO a given note (backlinks)
 */
export async function findBacklinks(
  targetName: string,
  options: { fuzzy?: boolean; threshold?: number; limit?: number } = {}
): Promise<Array<{ path: string; name: string; linkText: string }>> {
  const vaultPath = getVaultPath();
  const results: Array<{ path: string; name: string; linkText: string }> = [];
  const limit = options.limit || 50;
  const fuzzy = options.fuzzy ?? true;
  const threshold = options.threshold || 0.85;

  // Normalize target for fuzzy matching
  const normalizedTarget = targetName.toLowerCase().replace(/\s+/g, ' ').trim();

  async function scanDir(dir: string): Promise<void> {
    if (results.length >= limit) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= limit) break;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(vaultPath, fullPath);

        if (shouldExclude(relativePath)) continue;

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');

            // Extract all wikilinks
            const wikilinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
            let match;

            while ((match = wikilinkPattern.exec(content)) !== null) {
              const linkTarget = match[1];
              // Extract just the note name (last part of path)
              const linkName = linkTarget.split('/').pop() || linkTarget;
              const normalizedLink = linkName.toLowerCase().replace(/\s+/g, ' ').trim();

              // Check for match
              let isMatch = normalizedLink === normalizedTarget ||
                           normalizedLink.includes(normalizedTarget) ||
                           normalizedTarget.includes(normalizedLink);

              // Fuzzy match if enabled and no exact match
              if (!isMatch && fuzzy) {
                // Simple fuzzy: check if words overlap significantly
                const targetWords = new Set(normalizedTarget.split(' '));
                const linkWords = normalizedLink.split(' ');
                const matchingWords = linkWords.filter(w => targetWords.has(w)).length;
                const matchRatio = matchingWords / Math.max(targetWords.size, linkWords.length);
                isMatch = matchRatio >= threshold;
              }

              if (isMatch) {
                results.push({
                  path: relativePath.replace(/\.md$/, ''),
                  name: entry.name.replace(/\.md$/, ''),
                  linkText: match[0]
                });
                break; // Only count each file once
              }
            }
          } catch (e) {
            // Skip files we can't read
          }
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }
  }

  await scanDir(vaultPath);
  return results;
}

/**
 * Query notes by frontmatter field value
 */
export async function queryByFrontmatter(options: {
  field: string;
  value: string;
  entityType?: string;
  fuzzy?: boolean;
  threshold?: number;
  limit?: number;
}): Promise<NoteInfo[]> {
  const allNotes = await listNotes({
    entityType: options.entityType,
    limit: 500
  });

  const results: NoteInfo[] = [];
  const limit = options.limit || 50;
  const fuzzy = options.fuzzy ?? true;
  const threshold = options.threshold || 0.8;

  // Normalize search value
  const normalizedValue = options.value.toLowerCase()
    .replace(/\[\[.*?[|\/]?([^\]|\/]+)\]\]/g, '$1')  // Strip wikilink formatting
    .replace(/\s+/g, ' ')
    .trim();

  for (const note of allNotes) {
    if (results.length >= limit) break;

    if (!note.frontmatter) continue;

    let fieldValue = note.frontmatter[options.field];
    if (fieldValue === undefined) continue;

    // Handle array values (like attendees)
    if (Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        const normalizedItem = String(item).toLowerCase()
          .replace(/\[\[.*?[|\/]?([^\]|\/]+)\]\]/g, '$1')  // Strip wikilink formatting
          .replace(/\s+/g, ' ')
          .trim();

        if (normalizedItem === normalizedValue ||
            normalizedItem.includes(normalizedValue) ||
            normalizedValue.includes(normalizedItem)) {
          results.push(note);
          break;
        }

        // Fuzzy match if enabled
        if (fuzzy) {
          const valueWords = new Set(normalizedValue.split(' '));
          const itemWords = normalizedItem.split(' ');
          const matchingWords = itemWords.filter(w => valueWords.has(w)).length;
          const matchRatio = matchingWords / Math.max(valueWords.size, itemWords.length);
          if (matchRatio >= threshold) {
            results.push(note);
            break;
          }
        }
      }
    } else {
      // Single value
      const normalizedFieldValue = String(fieldValue).toLowerCase()
        .replace(/\[\[.*?[|\/]?([^\]|\/]+)\]\]/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();

      if (normalizedFieldValue === normalizedValue ||
          normalizedFieldValue.includes(normalizedValue) ||
          normalizedValue.includes(normalizedFieldValue)) {
        results.push(note);
      } else if (fuzzy) {
        const valueWords = new Set(normalizedValue.split(' '));
        const fieldWords = normalizedFieldValue.split(' ');
        const matchingWords = fieldWords.filter(w => valueWords.has(w)).length;
        const matchRatio = matchingWords / Math.max(valueWords.size, fieldWords.length);
        if (matchRatio >= threshold) {
          results.push(note);
        }
      }
    }
  }

  return results;
}
