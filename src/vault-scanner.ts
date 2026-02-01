/**
 * Vault Entity Scanner
 *
 * Scans Obsidian vault folders to discover entity notes and prepare them
 * for registration with the KOI backend.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  generateVaultRID,
  computeContentHash,
  ENTITY_FOLDERS,
  folderToEntityType,
  EntityFrontmatter,
} from './vault-rid.js';

// =============================================================================
// Types
// =============================================================================

export interface ScannedEntity {
  /** Absolute path to the file */
  absolutePath: string;

  /** Path relative to vault root */
  relativePath: string;

  /** Generated RID for this entity */
  rid: string;

  /** Entity type from @type or inferred from folder */
  entityType: string;

  /** Entity name from frontmatter or filename */
  name: string;

  /** Parsed YAML frontmatter */
  frontmatter: EntityFrontmatter;

  /** SHA256 hash of content (16 chars) */
  contentHash: string;

  /** Existing KOI metadata if present */
  existingKoi?: {
    rid?: string;
    canonical_uri?: string;
    sync_status?: string;
    last_synced?: string;
  };

  /** Whether this entity has @type in frontmatter */
  hasExplicitType: boolean;
}

export interface ScanResult {
  /** Successfully scanned entities */
  entities: ScannedEntity[];

  /** Paths that failed to parse */
  errors: Array<{
    path: string;
    error: string;
  }>;

  /** Scan statistics */
  stats: {
    totalFiles: number;
    scannedFiles: number;
    withFrontmatter: number;
    withType: number;
    byType: Record<string, number>;
  };
}

export interface ScanOptions {
  /** Folders to scan (default: ENTITY_FOLDERS) */
  folders?: string[];

  /** Only include entities with explicit @type */
  requireType?: boolean;

  /** Only include entities not already synced */
  excludeSynced?: boolean;
}

// =============================================================================
// YAML Frontmatter Parsing
// =============================================================================

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---/;

/**
 * Parse YAML frontmatter from note content.
 */
export function parseFrontmatter(content: string): {
  frontmatter: EntityFrontmatter | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: null, body: content };
  }

  try {
    let yamlText = match[1];

    // Handle @-prefixed keys (YAML reserved character)
    // Convert @type: to "@type":
    yamlText = yamlText.replace(
      /^(\s*)(@\w+)(\s*:)/gm,
      '$1"$2"$3'
    );

    const frontmatter = yaml.parse(yamlText) as EntityFrontmatter;
    const body = content.slice(match[0].length).trim();

    return { frontmatter, body };
  } catch (error) {
    // YAML parse failed
    return { frontmatter: null, body: content };
  }
}

/**
 * Serialize frontmatter back to YAML string.
 */
export function serializeFrontmatter(frontmatter: EntityFrontmatter): string {
  // Use yaml library with custom options to preserve formatting
  return yaml.stringify(frontmatter, {
    lineWidth: 0,  // Don't wrap lines
    singleQuote: false,
  });
}

/**
 * Reconstruct a note with updated frontmatter.
 */
export function reconstructNote(
  frontmatter: EntityFrontmatter,
  body: string
): string {
  const yamlStr = serializeFrontmatter(frontmatter);
  return `---\n${yamlStr}---\n\n${body}`;
}

// =============================================================================
// Entity Scanning
// =============================================================================

/**
 * Scan a single file and extract entity information.
 */
export function scanFile(
  vaultPath: string,
  vaultName: string,
  filePath: string
): ScannedEntity | null {
  const absolutePath = path.join(vaultPath, filePath);

  // Check file exists
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  // Read content
  const content = fs.readFileSync(absolutePath, 'utf-8');

  // Parse frontmatter
  const { frontmatter, body } = parseFrontmatter(content);

  // Get entity type
  const explicitType = frontmatter?.['@type'] || frontmatter?.type;
  const inferredType = folderToEntityType(filePath.split('/')[0]);
  const entityType = explicitType?.replace(/^schema:/, '') || inferredType;

  // Get entity name
  const filename = path.basename(filePath, '.md');
  const name = frontmatter?.name || filename;

  // Generate RID
  const rid = generateVaultRID(vaultName, filePath, frontmatter || undefined);

  // Compute content hash
  const contentHash = computeContentHash(content);

  // Check for existing KOI metadata
  const existingKoi = frontmatter?.koi as ScannedEntity['existingKoi'];

  return {
    absolutePath,
    relativePath: filePath,
    rid,
    entityType,
    name,
    frontmatter: frontmatter || {},
    contentHash,
    existingKoi,
    hasExplicitType: !!explicitType,
  };
}

/**
 * Scan vault folders for entity notes.
 */
export async function scanVaultEntities(
  vaultPath: string,
  vaultName: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const folders = options.folders || ENTITY_FOLDERS;
  const result: ScanResult = {
    entities: [],
    errors: [],
    stats: {
      totalFiles: 0,
      scannedFiles: 0,
      withFrontmatter: 0,
      withType: 0,
      byType: {},
    },
  };

  for (const folder of folders) {
    const folderPath = path.join(vaultPath, folder);

    // Skip if folder doesn't exist
    if (!fs.existsSync(folderPath)) {
      continue;
    }

    // Find all .md files in folder (recursive)
    const files = findMarkdownFiles(folderPath, vaultPath);
    result.stats.totalFiles += files.length;

    for (const filePath of files) {
      try {
        const entity = scanFile(vaultPath, vaultName, filePath);

        if (!entity) continue;
        result.stats.scannedFiles++;

        // Check if has frontmatter
        if (Object.keys(entity.frontmatter).length > 0) {
          result.stats.withFrontmatter++;
        }

        // Check if has explicit type
        if (entity.hasExplicitType) {
          result.stats.withType++;
        }

        // Apply filters
        if (options.requireType && !entity.hasExplicitType) {
          continue;
        }

        if (options.excludeSynced && entity.existingKoi?.sync_status === 'linked') {
          continue;
        }

        // Track by type
        result.stats.byType[entity.entityType] =
          (result.stats.byType[entity.entityType] || 0) + 1;

        result.entities.push(entity);
      } catch (error) {
        result.errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

/**
 * Find all markdown files in a directory (recursive).
 */
function findMarkdownFiles(dirPath: string, basePath: string): string[] {
  const files: string[] = [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories
      if (!entry.name.startsWith('.')) {
        files.push(...findMarkdownFiles(fullPath, basePath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Get path relative to vault root
      const relativePath = path.relative(basePath, fullPath);
      files.push(relativePath);
    }
  }

  return files;
}

// =============================================================================
// Sync Status Checking
// =============================================================================

export interface SyncStatus {
  /** Path to the entity file */
  path: string;

  /** Current RID */
  rid: string;

  /** Entity name */
  name: string;

  /** Status */
  status: 'linked' | 'local_only' | 'pending_sync' | 'conflict' | 'unknown';

  /** Canonical URI if linked */
  canonicalUri?: string;

  /** Last sync time */
  lastSynced?: string;

  /** Current content hash */
  currentHash: string;

  /** Hash at last sync (if available) */
  syncedHash?: string;

  /** Whether content has changed since sync */
  hasChanges: boolean;
}

/**
 * Check sync status for scanned entities.
 */
export function checkSyncStatus(
  entities: ScannedEntity[],
  backendEntities?: Map<string, { canonical_uri: string; content_hash: string }>
): SyncStatus[] {
  return entities.map(entity => {
    const existingKoi = entity.existingKoi;
    const backendEntry = backendEntities?.get(entity.rid);

    let status: SyncStatus['status'] = 'unknown';
    let hasChanges = false;

    if (existingKoi?.sync_status) {
      status = existingKoi.sync_status as SyncStatus['status'];
    } else if (existingKoi?.canonical_uri) {
      status = 'linked';
    } else {
      status = 'local_only';
    }

    // Check for content changes
    if (backendEntry && backendEntry.content_hash !== entity.contentHash) {
      hasChanges = true;
      if (status === 'linked') {
        status = 'pending_sync';
      }
    }

    return {
      path: entity.relativePath,
      rid: entity.rid,
      name: entity.name,
      status,
      canonicalUri: existingKoi?.canonical_uri || backendEntry?.canonical_uri,
      lastSynced: existingKoi?.last_synced,
      currentHash: entity.contentHash,
      syncedHash: backendEntry?.content_hash,
      hasChanges,
    };
  });
}
