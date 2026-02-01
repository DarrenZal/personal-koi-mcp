/**
 * Entity Schema Loader
 *
 * Loads entity type configurations from the backend API.
 * The backend is the single source of truth for entity types,
 * loading schemas from vault Ontology/ files.
 *
 * Key features:
 * - Fetches entity types from backend /entity-types endpoint
 * - Caches results with version-aware invalidation
 * - Provides sync helpers for contexts that can't use async
 * - Falls back to hardcoded defaults if backend unavailable
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

export interface EntityTypeConfig {
  type_key: string;
  label: string;
  folder: string;
  phonetic_matching: boolean;
  min_context_people: number;
  similarity_threshold: number;
  semantic_threshold: number;
  require_token_overlap: boolean;
}

export interface EntityTypesResponse {
  version: string;
  types: EntityTypeConfig[];
}

// =============================================================================
// Default Fallbacks
// =============================================================================

/**
 * Default entity type configs used when backend is unavailable.
 * These mirror the Python DEFAULT_SCHEMAS in entity_schema.py.
 */
const DEFAULT_ENTITY_TYPES: EntityTypeConfig[] = [
  {
    type_key: 'Person',
    label: 'Person',
    folder: 'People',
    phonetic_matching: true,
    min_context_people: 1,
    similarity_threshold: 0.92,
    semantic_threshold: 0.92,
    require_token_overlap: false,
  },
  {
    type_key: 'Organization',
    label: 'Organization',
    folder: 'Organizations',
    phonetic_matching: true,
    min_context_people: 2,
    similarity_threshold: 0.85,
    semantic_threshold: 0.95,
    require_token_overlap: true,
  },
  {
    type_key: 'Project',
    label: 'Project',
    folder: 'Projects',
    phonetic_matching: true,
    min_context_people: 2,
    similarity_threshold: 0.85,
    semantic_threshold: 0.93,
    require_token_overlap: true,
  },
  {
    type_key: 'Location',
    label: 'Location',
    folder: 'Locations',
    phonetic_matching: false,
    min_context_people: 2,
    similarity_threshold: 0.90,
    semantic_threshold: 0.95,
    require_token_overlap: true,
  },
  {
    type_key: 'Concept',
    label: 'Concept',
    folder: 'Concepts',
    phonetic_matching: false,
    min_context_people: 2,
    similarity_threshold: 0.75,
    semantic_threshold: 0.88,
    require_token_overlap: false,
  },
  {
    type_key: 'Meeting',
    label: 'Meeting',
    folder: 'Meetings',
    phonetic_matching: false,
    min_context_people: 1,
    similarity_threshold: 0.90,
    semantic_threshold: 0.92,
    require_token_overlap: true,
  },
];

// =============================================================================
// Cache State
// =============================================================================

let _cachedTypes: EntityTypeConfig[] | null = null;
let _cachedVersion: string | null = null;
let _typeToFolderMap: Map<string, string> | null = null;
let _folderToTypeMap: Map<string, string> | null = null;
let _lastFetchTime: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Configuration
// =============================================================================

function getBackendUrl(): string {
  // Try config file first
  const configPath = path.join(
    process.env.HOME || '',
    '.config',
    'personal-koi',
    'config.json'
  );

  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.backend?.url) {
        return config.backend.url;
      }
    }
  } catch (e) {
    // Fall back to default
  }

  return process.env.PERSONAL_KOI_BACKEND_URL || 'http://localhost:8351';
}

// =============================================================================
// Async API (Primary)
// =============================================================================

/**
 * Fetch entity types from backend API.
 * Returns cached result if version matches.
 */
export async function getEntityTypes(): Promise<EntityTypeConfig[]> {
  const now = Date.now();

  // Return cache if still valid
  if (_cachedTypes && now - _lastFetchTime < CACHE_TTL_MS) {
    return _cachedTypes;
  }

  try {
    const response = await axios.get<EntityTypesResponse>(
      `${getBackendUrl()}/entity-types`,
      { timeout: 5000 }
    );

    const { version, types } = response.data;

    // Invalidate cache if version changed
    if (version !== _cachedVersion) {
      _cachedTypes = types;
      _cachedVersion = version;
      _typeToFolderMap = null; // Invalidate derived maps
      _folderToTypeMap = null;
    }

    _lastFetchTime = now;
    return _cachedTypes!;
  } catch (e) {
    // Backend unavailable - use defaults
    console.warn('Entity schema backend unavailable, using defaults');
    if (!_cachedTypes) {
      _cachedTypes = DEFAULT_ENTITY_TYPES;
    }
    return _cachedTypes;
  }
}

/**
 * Get schema version from backend.
 */
export async function getSchemaVersion(): Promise<string> {
  await getEntityTypes(); // Ensure cache is populated
  return _cachedVersion || 'defaults';
}

/**
 * Force reload schemas from backend.
 */
export async function reloadEntityTypes(): Promise<EntityTypeConfig[]> {
  _cachedTypes = null;
  _cachedVersion = null;
  _typeToFolderMap = null;
  _folderToTypeMap = null;
  _lastFetchTime = 0;
  return getEntityTypes();
}

/**
 * Map entity type to vault folder (async).
 */
export async function typeToFolder(typeKey: string): Promise<string> {
  const types = await getEntityTypes();
  const found = types.find(
    t => t.type_key === typeKey || t.type_key.toLowerCase() === typeKey.toLowerCase()
  );
  return found?.folder || `${typeKey}s`; // Fallback: append 's'
}

/**
 * Map vault folder to entity type (async).
 */
export async function folderToType(folder: string): Promise<string | null> {
  const types = await getEntityTypes();
  const found = types.find(
    t => t.folder === folder || t.folder.toLowerCase() === folder.toLowerCase()
  );
  return found?.type_key || null;
}

/**
 * Get schema config for a specific type (async).
 */
export async function getSchemaForType(typeKey: string): Promise<EntityTypeConfig | null> {
  const types = await getEntityTypes();
  return types.find(
    t => t.type_key === typeKey || t.type_key.toLowerCase() === typeKey.toLowerCase()
  ) || null;
}

/**
 * Get all entity type keys (async).
 */
export async function getAllEntityTypeKeys(): Promise<string[]> {
  const types = await getEntityTypes();
  return types.map(t => t.type_key);
}

/**
 * Get all entity folders (async).
 */
export async function getAllEntityFolders(): Promise<string[]> {
  const types = await getEntityTypes();
  return types.map(t => t.folder);
}

// =============================================================================
// Sync API (For contexts that can't use async)
// =============================================================================

/**
 * Prefetch entity types and build sync maps.
 * MUST be called before using sync helpers.
 */
export async function prefetchEntityTypes(): Promise<void> {
  const types = await getEntityTypes();

  _typeToFolderMap = new Map();
  _folderToTypeMap = new Map();

  for (const t of types) {
    _typeToFolderMap.set(t.type_key.toLowerCase(), t.folder);
    _folderToTypeMap.set(t.folder.toLowerCase(), t.type_key);
  }
}

/**
 * Map entity type to folder (sync).
 * Requires prefetchEntityTypes() to be called first.
 */
export function typeToFolderSync(typeKey: string): string {
  if (!_typeToFolderMap) {
    console.warn('typeToFolderSync called before prefetchEntityTypes - using fallback');
    // Build map from defaults
    _typeToFolderMap = new Map(
      DEFAULT_ENTITY_TYPES.map(t => [t.type_key.toLowerCase(), t.folder])
    );
  }
  return _typeToFolderMap.get(typeKey.toLowerCase()) || `${typeKey}s`;
}

/**
 * Map folder to entity type (sync).
 * Requires prefetchEntityTypes() to be called first.
 */
export function folderToTypeSync(folder: string): string | null {
  if (!_folderToTypeMap) {
    console.warn('folderToTypeSync called before prefetchEntityTypes - using fallback');
    // Build map from defaults
    _folderToTypeMap = new Map(
      DEFAULT_ENTITY_TYPES.map(t => [t.folder.toLowerCase(), t.type_key])
    );
  }
  return _folderToTypeMap.get(folder.toLowerCase()) || null;
}

/**
 * Get all entity folders (sync).
 * Requires prefetchEntityTypes() to be called first.
 */
export function getAllEntityFoldersSync(): string[] {
  if (!_cachedTypes) {
    console.warn('getAllEntityFoldersSync called before prefetchEntityTypes - using defaults');
    return DEFAULT_ENTITY_TYPES.map(t => t.folder);
  }
  return _cachedTypes.map(t => t.folder);
}

/**
 * Check if a folder is an entity folder (sync).
 */
export function isEntityFolderSync(folder: string): boolean {
  const folders = getAllEntityFoldersSync();
  return folders.some(f => f.toLowerCase() === folder.toLowerCase());
}

// =============================================================================
// Compatibility Layer
// =============================================================================

/**
 * Legacy entityTypeToFolder function for backward compatibility.
 * Uses sync version with fallback to defaults.
 */
export function entityTypeToFolder(entityType: string): string {
  return typeToFolderSync(entityType);
}

/**
 * Legacy folderToEntityType function for backward compatibility.
 * Uses sync version with fallback to defaults.
 */
export function folderToEntityType(folder: string): string {
  return folderToTypeSync(folder) || folder;
}

/**
 * Legacy ENTITY_FOLDERS constant replacement.
 * Returns array of entity folder names.
 */
export function getEntityFolders(): string[] {
  return getAllEntityFoldersSync();
}
