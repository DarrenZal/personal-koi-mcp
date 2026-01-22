/**
 * Backend Client Module
 *
 * HTTP client for communicating with the personal KOI-processor backend.
 * Handles entity ingestion, deduplication, and retrieval.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

export interface ExtractedEntity {
  name: string;
  type: string;  // Person, Organization, Location, Project, Concept
  mentions: string[];
  confidence: number;
  context?: string;
}

export interface ExtractedRelationship {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

export interface IngestRequest {
  document_rid: string;
  content?: string;
  entities: ExtractedEntity[];
  relationships?: ExtractedRelationship[];
  source?: string;
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

      // Map type to folder
      const folder = type === 'person' ? 'People' :
                    type === 'organization' ? 'Organizations' :
                    type === 'location' ? 'Locations' :
                    type === 'project' ? 'Projects' :
                    'Concepts';

      return `${folder}/${name}`;
    }

    // Fallback: derive from entity type
    const folder = entityType === 'Person' ? 'People' :
                  entityType === 'Organization' ? 'Organizations' :
                  entityType === 'Location' ? 'Locations' :
                  entityType === 'Project' ? 'Projects' :
                  'Concepts';

    return `${folder}/Unknown`;
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
