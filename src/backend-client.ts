/**
 * Backend Client Module
 *
 * HTTP client for communicating with the personal KOI-processor backend.
 * Handles entity ingestion, deduplication, and retrieval.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { typeToFolderSync, EntityTypeConfig, getEntityTypes } from './entity-schema.js';

// =============================================================================
// Types
// =============================================================================

export interface ExtractedEntity {
  name: string;
  type: string;  // Person, Organization, Location, Project, Concept
  mentions: string[];
  confidence: number;
  context?: string;
  // Per-entity context for resolution (merged with global context)
  associated_people?: string[];
  associated_organizations?: string[];
}

export interface ExtractedRelationship {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

export interface ResolutionContext {
  associated_people?: string[];  // People in the meeting/document (backend naming)
  organizations?: string[];       // Organizations mentioned
  project?: string;               // Project context for multi-hop resolution
  topics?: string[];              // Topics for future use
  associated_orgs?: string[];     // Deprecated: use organizations instead
  source_text?: string;
}

export interface IngestRequest {
  document_rid: string;
  content?: string;
  entities: ExtractedEntity[];
  relationships?: ExtractedRelationship[];
  source?: string;
  context?: ResolutionContext;  // For contextual entity resolution (Tier 1.5)
}

export interface CanonicalEntity {
  name: string;
  uri: string;
  type: string;
  is_new: boolean;
  merged_with?: string | null;
  confidence: number;
}

export interface IngestResponse {
  success: boolean;
  canonical_entities: CanonicalEntity[];
  receipt_rid: string;
  stats: {
    entities_processed: number;
    new_entities: number;
    resolved_entities: number;
    relationships_processed: number;
  };
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  mode: string;
  database: string;
  openai_available?: boolean;
  embedding_model?: string | null;
  semantic_matching?: boolean;
  resolution_tiers?: {
    tier1_exact: boolean;
    tier1x_fuzzy: boolean;
    tier2_semantic: boolean;
    tier3_create: boolean;
  };
  error?: string;
}

export interface EntityInfo {
  fuseki_uri: string;
  entity_text: string;
  entity_type: string;
  source: string;
  created_at: string;
}

export interface EntityDetail {
  entity: {
    fuseki_uri: string;
    entity_text: string;
    entity_type: string;
    normalized_text: string;
    source: string;
    first_seen_rid: string;
    metadata: Record<string, any>;
    created_at: string;
  };
  documents: Array<{
    document_rid: string;
    mention_count: number;
    context: string;
    created_at: string;
  }>;
}

export interface BackendStats {
  total_entities: number;
  by_type: Record<string, number>;
  recent_entities: Array<{
    entity_text: string;
    entity_type: string;
    created_at: string;
  }>;
  mode: string;
}

export interface RegisterEntityRequest {
  vault_rid: string;
  vault_path: string;
  entity_type: string;
  name: string;
  properties: Record<string, any>;
  frontmatter?: Record<string, any>;  // Preferred - for relationship extraction
  content_hash: string;
}

export interface RegisterEntityResponse {
  success: boolean;
  canonical_uri: string;
  is_new: boolean;
  vault_rid: string;
  merged_with?: string;
}

export interface VaultEntityMapping {
  vault_rid: string;
  vault_path: string;
  canonical_uri: string;
  entity_type: string;
  name: string;
  sync_status: 'linked' | 'local_only' | 'pending_sync' | 'conflict';
  content_hash: string;
  last_synced: string;
}

export interface VaultEntitiesResponse {
  entities: VaultEntityMapping[];
  count: number;
  limit: number;
  offset: number;
}

// =============================================================================
// Configuration
// =============================================================================

interface BackendConfig {
  url: string;
  timeout_ms: number;
}

interface PersonalKoiConfig {
  backend: BackendConfig;
  database?: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  mode?: string;
  obsidian_vault_path?: string;
}

function loadConfig(): BackendConfig {
  const configPath = path.join(
    process.env.HOME || '',
    '.config',
    'personal-koi',
    'config.json'
  );

  try {
    if (fs.existsSync(configPath)) {
      const config: PersonalKoiConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.backend;
    }
  } catch (e) {
    // Fall back to defaults
  }

  // Default configuration
  return {
    url: process.env.PERSONAL_KOI_BACKEND_URL || 'http://localhost:8351',
    timeout_ms: parseInt(process.env.PERSONAL_KOI_TIMEOUT || '30000', 10)
  };
}

// =============================================================================
// Backend Client
// =============================================================================

export class BackendClient {
  private client: any;
  private config: BackendConfig;
  private _isAvailable: boolean | null = null;
  private _lastHealthCheck: number = 0;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

  constructor(config?: Partial<BackendConfig>) {
    this.config = { ...loadConfig(), ...config };

    this.client = axios.create({
      baseURL: this.config.url,
      timeout: this.config.timeout_ms,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Check if the backend is available
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();

    // Use cached result if recent
    if (
      this._isAvailable !== null &&
      now - this._lastHealthCheck < this.HEALTH_CHECK_INTERVAL
    ) {
      return this._isAvailable;
    }

    try {
      const response = await this.client.get('/health');
      this._isAvailable = response.data.status === 'healthy';
      this._lastHealthCheck = now;
      return this._isAvailable;
    } catch (e) {
      this._isAvailable = false;
      this._lastHealthCheck = now;
      return false;
    }
  }

  /**
   * Get health status
   */
  async getHealth(): Promise<HealthStatus> {
    try {
      const response = await this.client.get('/health');
      return response.data;
    } catch (e) {
      const error = e as any;
      return {
        status: 'unhealthy',
        mode: 'unknown',
        database: 'disconnected',
        error: error.message,
      };
    }
  }

  /**
   * Ingest extracted entities into the backend
   *
   * This sends entities already extracted by Claude Code to the backend for:
   * 1. Deduplication against existing entities
   * 2. Canonical URI assignment
   * 3. Storage in the knowledge base
   */
  async ingestEntities(request: IngestRequest): Promise<IngestResponse> {
    try {
      const response = await this.client.post('/ingest', {
        document_rid: request.document_rid,
        content: request.content,
        entities: request.entities,
        relationships: request.relationships || [],
        source: request.source || 'obsidian-vault',
        context: request.context,  // Pass context for Tier 1.5 resolution
      });

      return response.data;
    } catch (e) {
      const error = e as any;

      // Check if it's a structured error response
      if (error.response?.data) {
        const data = error.response.data as { detail?: string };
        throw new Error(`Backend error: ${data.detail || 'Unknown error'}`);
      }

      throw new Error(`Failed to ingest entities: ${error.message}`);
    }
  }

  /**
   * List entities in the knowledge base
   */
  async listEntities(options: {
    entityType?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    entities: EntityInfo[];
    count: number;
    limit: number;
    offset: number;
  }> {
    try {
      const params = new URLSearchParams();
      if (options.entityType) params.set('entity_type', options.entityType);
      if (options.limit) params.set('limit', options.limit.toString());
      if (options.offset) params.set('offset', options.offset.toString());

      const response = await this.client.get(`/entities?${params.toString()}`);
      return response.data;
    } catch (e) {
      const error = e as any;
      throw new Error(`Failed to list entities: ${error.message}`);
    }
  }

  /**
   * Get a specific entity by URI
   */
  async getEntity(entityUri: string): Promise<EntityDetail> {
    try {
      const response = await this.client.get(
        `/entity/${encodeURIComponent(entityUri)}`
      );
      return response.data;
    } catch (e) {
      const error = e as any;
      if (error.response?.status === 404) {
        throw new Error(`Entity not found: ${entityUri}`);
      }
      throw new Error(`Failed to get entity: ${error.message}`);
    }
  }

  /**
   * Get knowledge base statistics
   */
  async getStats(): Promise<BackendStats> {
    try {
      const response = await this.client.get('/stats');
      return response.data;
    } catch (e) {
      const error = e as any;
      throw new Error(`Failed to get stats: ${error.message}`);
    }
  }

  /**
   * Register a vault entity with the backend.
   *
   * This registers an existing vault entity note (from People/, Organizations/, etc.)
   * with the backend for:
   * 1. Deduplication against existing entities
   * 2. Canonical URI assignment
   * 3. RID mapping storage
   */
  async registerEntity(request: RegisterEntityRequest): Promise<RegisterEntityResponse> {
    try {
      const response = await this.client.post('/register-entity', {
        vault_rid: request.vault_rid,
        vault_path: request.vault_path,
        entity_type: request.entity_type,
        name: request.name,
        properties: request.properties,
        frontmatter: request.frontmatter || request.properties,  // Send frontmatter explicitly for relationship extraction
        content_hash: request.content_hash,
      });

      return response.data;
    } catch (e) {
      const error = e as any;

      // Check if endpoint doesn't exist yet (404)
      if (error.response?.status === 404) {
        throw new Error(
          'Backend /register-entity endpoint not found. ' +
          'The backend may need to be updated to support vault entity registration.'
        );
      }

      // Check if it's a structured error response
      if (error.response?.data) {
        const data = error.response.data as { detail?: string };
        throw new Error(`Backend error: ${data.detail || 'Unknown error'}`);
      }

      throw new Error(`Failed to register entity: ${error.message}`);
    }
  }

  /**
   * Get all vault entities registered with the backend.
   */
  async getVaultEntities(options: {
    entityType?: string;
    syncStatus?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<VaultEntitiesResponse> {
    try {
      const params = new URLSearchParams();
      if (options.entityType) params.set('entity_type', options.entityType);
      if (options.syncStatus) params.set('sync_status', options.syncStatus);
      if (options.limit) params.set('limit', options.limit.toString());
      if (options.offset) params.set('offset', options.offset.toString());

      const response = await this.client.get(`/vault-entities?${params.toString()}`);
      return response.data;
    } catch (e) {
      const error = e as any;

      // Check if endpoint doesn't exist yet (404)
      if (error.response?.status === 404) {
        // Return empty result if endpoint not implemented
        return {
          entities: [],
          count: 0,
          limit: options.limit || 100,
          offset: options.offset || 0,
        };
      }

      throw new Error(`Failed to get vault entities: ${error.message}`);
    }
  }

  /**
   * Resolve canonical URIs to vault paths for wikilink generation.
   *
   * Given a list of canonical entity URIs, returns the corresponding vault paths
   * and pre-formatted wikilinks.
   */
  async resolveToVaultPaths(uris: string[]): Promise<{
    mappings: Array<{
      canonical_uri: string;
      vault_path: string;
      name: string;
      entity_type: string;
      wikilink: string;
    }>;
    not_found: string[];
    resolved: number;
    total: number;
  }> {
    try {
      const response = await this.client.post('/resolve-to-vault', uris);
      return response.data;
    } catch (e) {
      const error = e as any;

      // Check if endpoint doesn't exist yet (404)
      if (error.response?.status === 404) {
        // Return empty result - use fallback path generation
        return {
          mappings: [],
          not_found: uris,
          resolved: 0,
          total: uris.length,
        };
      }

      throw new Error(`Failed to resolve URIs to vault paths: ${error.message}`);
    }
  }

  /**
   * Get contextual entity candidates based on related meetings.
   *
   * When processing a meeting, this helps resolve ambiguous names like "Sean"
   * by returning people from related meetings (same project, common attendees).
   */
  async getContextualCandidates(options: {
    project?: string;
    attendees?: string[];
    topics?: string[];
    documentRid?: string;
  } = {}): Promise<{
    candidates: Array<{
      name: string;
      uri: string;
      normalized_name: string;
      source_documents: string[];
      vault_path?: string;
    }>;
    related_documents: string[];
    context_types: string[];
    candidate_count: number;
    related_document_count: number;
  }> {
    try {
      const response = await this.client.post('/get-contextual-candidates', {
        project: options.project,
        attendees: options.attendees,
        topics: options.topics,
        document_rid: options.documentRid,
      });
      return response.data;
    } catch (e) {
      const error = e as any;

      // Check if endpoint doesn't exist yet (404)
      if (error.response?.status === 404) {
        // Return empty result
        return {
          candidates: [],
          related_documents: [],
          context_types: [],
          candidate_count: 0,
          related_document_count: 0,
        };
      }

      throw new Error(`Failed to get contextual candidates: ${error.message}`);
    }
  }

  /**
   * Convert document path to RID
   */
  static pathToRid(vaultPath: string, docPath: string): string {
    // Remove vault path prefix if present
    let relativePath = docPath;
    if (docPath.startsWith(vaultPath)) {
      relativePath = docPath.slice(vaultPath.length);
    }

    // Remove leading slash and .md extension
    relativePath = relativePath.replace(/^\//, '').replace(/\.md$/, '');

    // Create vault RID
    return `vault:${relativePath}`;
  }

  /**
   * Map canonical entity URI to vault path
   */
  static uriToVaultPath(uri: string, entityType: string): string {
    // Extract entity name from URI
    // URI format: orn:personal-koi.entity:person-john-smith-abc123
    const match = uri.match(/orn:personal-koi\.entity:([a-z]+)-(.+?)-[a-f0-9]+$/);

    if (match) {
      const type = match[1];
      const slugName = match[2];

      // Convert slug back to title case
      const name = slugName
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      // Map type to folder (schema-driven, capitalize first letter for lookup)
      const typeKey = type.charAt(0).toUpperCase() + type.slice(1);
      const folder = typeToFolderSync(typeKey);

      return `${folder}/${name}`;
    }

    // Fallback: derive from entity type (schema-driven)
    const folder = typeToFolderSync(entityType);
    return `${folder}/Unknown`;
  }

  /**
   * Get entity types from backend
   */
  async getEntityTypes(): Promise<EntityTypeConfig[]> {
    return getEntityTypes();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let _backendClient: BackendClient | null = null;

export function getBackendClient(): BackendClient {
  if (!_backendClient) {
    _backendClient = new BackendClient();
  }
  return _backendClient;
}

export function resetBackendClient(): void {
  _backendClient = null;
}
