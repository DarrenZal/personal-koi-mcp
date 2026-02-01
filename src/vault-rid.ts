/**
 * Vault RID (Resource Identifier) Module
 *
 * Generates and parses RIDs for Obsidian vault notes, compatible with
 * koi-sensors/obsidian_sensor.py RID format.
 *
 * RID Formats:
 * - Notes: orn:obsidian.note:<vault>/<path>
 * - Entities: orn:obsidian.entity:<vault>/<type>/<id>
 *
 * Reference: koi-sensors/sensors/obsidian/obsidian_sensor.py
 */

import crypto from 'crypto';
import {
  entityTypeToFolder,
  folderToEntityType,
  getEntityFolders,
  isEntityFolderSync,
} from './entity-schema.js';

// =============================================================================
// Types
// =============================================================================

export interface VaultRIDConfig {
  vaultName: string;        // e.g., "Notes"
  vaultPath: string;        // Full path: "/Users/darrenzal/Documents/Notes"
}

export interface ParsedVaultRID {
  valid: boolean;
  ridType: 'note' | 'entity' | 'unknown';
  vaultName: string | null;
  path: string | null;          // For notes: full path
  entityType: string | null;    // For entities: Person, Organization, etc.
  entityId: string | null;      // For entities: normalized ID
  error?: string;
}

export interface EntityFrontmatter {
  '@type'?: string;
  '@id'?: string;
  type?: string;
  id?: string;
  name?: string;
  [key: string]: any;
}

// =============================================================================
// RID Generation
// =============================================================================

/**
 * Generate a note RID for a vault file.
 * Format: orn:obsidian.note:<vault>/<path>
 *
 * @param vaultName - Name of the vault (e.g., "Notes")
 * @param notePath - Path relative to vault root (e.g., "People/Clare Attwell.md")
 * @returns RID string
 */
export function generateNoteRID(vaultName: string, notePath: string): string {
  // Normalize path: remove .md extension, use forward slashes, replace spaces with hyphens
  const normalized = notePath
    .replace(/\.md$/, '')
    .replace(/\\/g, '/')
    .replace(/ /g, '-');

  return `orn:obsidian.note:${vaultName}/${normalized}`;
}

/**
 * Generate an entity RID for a typed vault entity.
 * Format: orn:obsidian.entity:<vault>/<type>/<id>
 *
 * @param vaultName - Name of the vault
 * @param entityType - Schema.org type (e.g., "Person", "Organization")
 * @param entityId - Entity identifier (usually from @id or derived from name)
 * @returns RID string
 */
export function generateEntityRID(
  vaultName: string,
  entityType: string,
  entityId: string
): string {
  // Normalize type: remove schema: prefix if present
  const normalizedType = entityType.replace(/^schema:/, '');

  // Normalize ID: lowercase, replace spaces with hyphens
  const normalizedId = entityId.toLowerCase().replace(/ /g, '-');

  return `orn:obsidian.entity:${vaultName}/${normalizedType}/${normalizedId}`;
}

/**
 * Generate the appropriate RID for a vault note based on its frontmatter.
 * Uses entity RID if @type is present, otherwise note RID.
 *
 * @param vaultName - Name of the vault
 * @param notePath - Path relative to vault root
 * @param frontmatter - Parsed YAML frontmatter (optional)
 * @returns RID string
 */
export function generateVaultRID(
  vaultName: string,
  notePath: string,
  frontmatter?: EntityFrontmatter
): string {
  // Check if this is a typed entity
  const entityType = frontmatter?.['@type'] || frontmatter?.type;

  if (entityType) {
    // Get entity ID from frontmatter or derive from name/path
    let entityId = frontmatter?.['@id'] || frontmatter?.id;

    if (!entityId) {
      // Derive from name if present
      if (frontmatter?.name) {
        entityId = frontmatter.name.toLowerCase().replace(/ /g, '-');
      } else {
        // Derive from filename
        const filename = notePath.split('/').pop() || notePath;
        entityId = filename.replace(/\.md$/, '').toLowerCase().replace(/ /g, '-');
      }
    }

    return generateEntityRID(vaultName, entityType, entityId);
  }

  // Default to note RID
  return generateNoteRID(vaultName, notePath);
}

// =============================================================================
// RID Parsing
// =============================================================================

/**
 * Parse a vault RID into its components.
 *
 * @param rid - The RID string to parse
 * @returns Parsed RID components
 */
export function parseVaultRID(rid: string): ParsedVaultRID {
  const result: ParsedVaultRID = {
    valid: false,
    ridType: 'unknown',
    vaultName: null,
    path: null,
    entityType: null,
    entityId: null,
  };

  if (!rid || typeof rid !== 'string') {
    result.error = 'RID must be a non-empty string';
    return result;
  }

  // Parse orn:obsidian.note:<vault>/<path>
  const noteMatch = rid.match(/^orn:obsidian\.note:([^/]+)\/(.+)$/);
  if (noteMatch) {
    result.valid = true;
    result.ridType = 'note';
    result.vaultName = noteMatch[1];
    result.path = noteMatch[2].replace(/-/g, ' '); // Restore spaces
    return result;
  }

  // Parse orn:obsidian.entity:<vault>/<type>/<id>
  const entityMatch = rid.match(/^orn:obsidian\.entity:([^/]+)\/([^/]+)\/(.+)$/);
  if (entityMatch) {
    result.valid = true;
    result.ridType = 'entity';
    result.vaultName = entityMatch[1];
    result.entityType = entityMatch[2];
    result.entityId = entityMatch[3];
    return result;
  }

  result.error = 'RID does not match obsidian.note or obsidian.entity format';
  return result;
}

/**
 * Convert a vault RID back to a file path.
 *
 * @param rid - The RID string
 * @returns File path relative to vault root, or null if invalid
 */
export function ridToVaultPath(rid: string): string | null {
  const parsed = parseVaultRID(rid);
  if (!parsed.valid) return null;

  if (parsed.ridType === 'note' && parsed.path) {
    return parsed.path + '.md';
  }

  if (parsed.ridType === 'entity' && parsed.entityType && parsed.entityId) {
    // Map entity type to folder
    const folder = entityTypeToFolder(parsed.entityType);
    // Convert ID back to title case for filename
    const filename = parsed.entityId
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return `${folder}/${filename}.md`;
  }

  return null;
}

// entityTypeToFolder and folderToEntityType are now imported from entity-schema.ts
// Re-export them for backward compatibility
export { entityTypeToFolder, folderToEntityType } from './entity-schema.js';

// =============================================================================
// Content Hashing
// =============================================================================

/**
 * Compute a content hash for change detection.
 * Uses SHA256, truncated to 16 characters for compactness.
 *
 * @param content - File content to hash
 * @returns Hex hash string (16 chars)
 */
export function computeContentHash(content: string): string {
  return crypto
    .createHash('sha256')
    .update(content, 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Check if a string is a valid Obsidian vault RID.
 */
export function isVaultRID(rid: string): boolean {
  return parseVaultRID(rid).valid;
}

/**
 * Check if a RID is an entity RID (vs a note RID).
 */
export function isEntityRID(rid: string): boolean {
  const parsed = parseVaultRID(rid);
  return parsed.valid && parsed.ridType === 'entity';
}

/**
 * Check if a RID is a note RID (vs an entity RID).
 */
export function isNoteRID(rid: string): boolean {
  const parsed = parseVaultRID(rid);
  return parsed.valid && parsed.ridType === 'note';
}

// =============================================================================
// Entity Folder Detection
// =============================================================================

/**
 * List of folders that contain entity notes.
 * Now dynamically loaded from schema - use getEntityFolders() for runtime access.
 * @deprecated Use getEntityFolders() from entity-schema.ts instead
 */
export const ENTITY_FOLDERS = getEntityFolders();

/**
 * Check if a path is in an entity folder.
 */
export function isEntityPath(path: string): boolean {
  const firstFolder = path.split('/')[0];
  return isEntityFolderSync(firstFolder);
}

/**
 * Infer entity type from path if not specified in frontmatter.
 */
export function inferEntityTypeFromPath(path: string): string | null {
  const firstFolder = path.split('/')[0];
  if (isEntityFolderSync(firstFolder)) {
    return folderToEntityType(firstFolder);
  }
  return null;
}
