# Vault ↔ KOI Sync Implementation Plan

This document outlines the implementation steps for syncing Obsidian vault YAML frontmatter with the personal KOI backend.

## Current State

**Implemented:**
- Entity extraction from document *content* via Claude
- Backend deduplication (3-tier: exact, fuzzy, semantic)
- `vault_ingest_extraction` tool for document processing
- Basic entity storage in `entity_registry`

**Not Implemented:**
- Reading existing vault entity notes (People/, Organizations/, etc.)
- Registering vault entities in backend
- RID generation and mapping
- YAML frontmatter updates with KOI metadata
- Bidirectional sync status tracking

## Implementation Phases

### Phase 1: RID Generation & Vault Scanning

**Goal:** Generate RIDs for vault notes and scan existing entities

#### 1.1 RID Generator Module

**File:** `src/rid.ts`

```typescript
export interface RIDConfig {
  namespace: string;    // e.g., "regen.document"
  source: string;       // e.g., "obsidian"
}

export function generateVaultRID(vaultPath: string, config: RIDConfig): string {
  // Normalize path: "People/Clare Attwell.md" -> "People/Clare-Attwell"
  const normalized = vaultPath
    .replace(/\.md$/, '')
    .replace(/ /g, '-');

  return `orn:${config.namespace}:${config.source}/${normalized}`;
}

export function parseVaultRID(rid: string): { namespace: string; source: string; path: string } | null {
  const match = rid.match(/^orn:([^:]+):([^/]+)\/(.+)$/);
  if (!match) return null;
  return { namespace: match[1], source: match[2], path: match[3] };
}

export function vaultPathFromRID(rid: string): string | null {
  const parsed = parseVaultRID(rid);
  if (!parsed) return null;
  return parsed.path.replace(/-/g, ' ') + '.md';
}
```

#### 1.2 Vault Entity Scanner

**File:** `src/vault-scanner.ts`

```typescript
export interface ScannedEntity {
  path: string;
  rid: string;
  type: string;           // From @type in frontmatter
  name: string;           // From name field or filename
  properties: Record<string, any>;
  contentHash: string;
  existingKoiMetadata?: {
    canonical_uri?: string;
    sync_status?: string;
    last_synced?: string;
  };
}

export async function scanVaultEntities(
  vaultPath: string,
  folders: string[]
): Promise<ScannedEntity[]> {
  // For each folder (People, Organizations, etc.)
  // - List all .md files
  // - Parse YAML frontmatter
  // - Extract @type, name, properties
  // - Generate RID
  // - Compute content hash
  // - Check for existing koi: metadata
}
```

### Phase 2: Backend Entity Registration

**Goal:** Register vault entities in backend and track RID mappings

#### 2.1 Database Schema Update

**File:** `migrations/XXX_add_rid_mappings.sql` (in koi-processor)

```sql
-- Table to map vault RIDs to canonical entities
CREATE TABLE IF NOT EXISTS entity_rid_mappings (
  id SERIAL PRIMARY KEY,
  vault_rid VARCHAR(500) NOT NULL UNIQUE,
  vault_path VARCHAR(500) NOT NULL,
  canonical_uri VARCHAR(500) NOT NULL,
  entity_type VARCHAR(100),
  content_hash VARCHAR(100),
  sync_status VARCHAR(20) DEFAULT 'linked',
  last_synced TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_canonical_uri
    FOREIGN KEY (canonical_uri)
    REFERENCES entity_registry(fuseki_uri)
    ON DELETE CASCADE,

  CONSTRAINT valid_sync_status CHECK (
    sync_status IN ('linked', 'local_only', 'pending_sync', 'conflict')
  )
);

CREATE INDEX idx_rid_mappings_canonical ON entity_rid_mappings(canonical_uri);
CREATE INDEX idx_rid_mappings_vault_path ON entity_rid_mappings(vault_path);
CREATE INDEX idx_rid_mappings_sync_status ON entity_rid_mappings(sync_status);

-- Add vault_rid column to entity_registry for direct lookup
ALTER TABLE entity_registry
ADD COLUMN IF NOT EXISTS vault_rid VARCHAR(500);

CREATE INDEX idx_entity_registry_vault_rid ON entity_registry(vault_rid);
```

#### 2.2 Backend API Endpoint

**File:** `api/personal_ingest_api.py` (in koi-processor)

```python
@app.post("/register-entity")
async def register_vault_entity(request: RegisterEntityRequest):
    """
    Register a vault entity note in the backend.

    - Checks if entity already exists (by name + type)
    - Creates new or links to existing
    - Stores RID mapping
    - Returns canonical URI
    """

    # 1. Check for existing entity by normalized name + type
    existing = await find_existing_entity(
        name=request.name,
        entity_type=request.entity_type
    )

    if existing:
        # Link vault RID to existing canonical URI
        canonical_uri = existing.fuseki_uri
        is_new = False
    else:
        # Create new entity in registry
        canonical_uri = generate_entity_uri(request.name, request.entity_type)
        await create_entity(
            fuseki_uri=canonical_uri,
            entity_text=request.name,
            entity_type=request.entity_type,
            vault_rid=request.vault_rid,
            metadata=request.properties
        )
        is_new = True

    # 2. Create/update RID mapping
    await upsert_rid_mapping(
        vault_rid=request.vault_rid,
        vault_path=request.vault_path,
        canonical_uri=canonical_uri,
        entity_type=request.entity_type,
        content_hash=request.content_hash
    )

    return {
        "success": True,
        "canonical_uri": canonical_uri,
        "is_new": is_new,
        "vault_rid": request.vault_rid
    }
```

#### 2.3 Backend Client Extension

**File:** `src/backend-client.ts` (add to existing)

```typescript
export interface RegisterEntityRequest {
  vault_rid: string;
  vault_path: string;
  entity_type: string;
  name: string;
  properties: Record<string, any>;
  content_hash: string;
}

export interface RegisterEntityResponse {
  success: boolean;
  canonical_uri: string;
  is_new: boolean;
  vault_rid: string;
}

// Add to BackendClient class:
async registerEntity(request: RegisterEntityRequest): Promise<RegisterEntityResponse> {
  const response = await this.client.post('/register-entity', request);
  return response.data;
}

async getVaultEntities(): Promise<{
  entities: Array<{
    vault_rid: string;
    vault_path: string;
    canonical_uri: string;
    sync_status: string;
  }>;
  count: number;
}> {
  const response = await this.client.get('/vault-entities');
  return response.data;
}
```

### Phase 3: MCP Tools

**Goal:** Add tools for registering and syncing vault entities

#### 3.1 vault_register_entity

Register a single vault entity note.

**File:** `src/tools.ts` (add definition)

```typescript
{
  name: 'vault_register_entity',
  description: 'Register a vault entity note (People, Organizations, etc.) with the KOI backend. Creates a RID mapping and updates the note with KOI metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the entity note (e.g., "People/Clare Attwell.md")'
      },
      update_frontmatter: {
        type: 'boolean',
        description: 'Whether to update the note with koi: metadata (default: true)',
        default: true
      }
    },
    required: ['path']
  }
}
```

**File:** `src/index.ts` (add handler)

```typescript
case 'vault_register_entity': {
  const { path, update_frontmatter = true } = args;

  // 1. Read the note
  const note = await readNote(vaultPath, path);

  // 2. Parse frontmatter
  const { frontmatter, content } = parseNote(note);

  // 3. Generate RID
  const rid = generateVaultRID(path, ridConfig);

  // 4. Compute content hash
  const contentHash = computeHash(note);

  // 5. Register with backend
  const result = await backendClient.registerEntity({
    vault_rid: rid,
    vault_path: path,
    entity_type: frontmatter['@type'] || 'Unknown',
    name: frontmatter.name || pathToName(path),
    properties: frontmatter,
    content_hash: contentHash
  });

  // 6. Update frontmatter if requested
  if (update_frontmatter) {
    const updatedFrontmatter = {
      ...frontmatter,
      koi: {
        rid: rid,
        canonical_uri: result.canonical_uri,
        sync_status: 'linked',
        last_synced: new Date().toISOString()
      }
    };
    await writeNote(vaultPath, path, updatedFrontmatter, content);
  }

  return {
    success: true,
    path,
    rid,
    canonical_uri: result.canonical_uri,
    is_new: result.is_new
  };
}
```

#### 3.2 vault_sync_entities

Bulk sync all entities from specified folders.

```typescript
{
  name: 'vault_sync_entities',
  description: 'Bulk register all entity notes from specified folders with the KOI backend.',
  inputSchema: {
    type: 'object',
    properties: {
      folders: {
        type: 'array',
        items: { type: 'string' },
        description: 'Folders to scan (default: ["People", "Organizations", "Projects", "Locations", "Concepts"])'
      },
      mode: {
        type: 'string',
        enum: ['register_new', 'full_sync'],
        description: 'register_new: only unregistered entities. full_sync: all entities.',
        default: 'register_new'
      },
      update_frontmatter: {
        type: 'boolean',
        default: true
      }
    }
  }
}
```

#### 3.3 vault_check_sync_status

Check sync status for vault entities.

```typescript
{
  name: 'vault_check_sync_status',
  description: 'Check sync status between vault entities and KOI backend.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'Folder to check (e.g., "People"). If omitted, checks all entity folders.'
      }
    }
  }
}
```

### Phase 4: Frontmatter Integration

**Goal:** Safely update vault notes with KOI metadata

#### 4.1 Frontmatter Update Logic

**File:** `src/frontmatter.ts`

```typescript
export interface KoiMetadata {
  rid: string;
  canonical_uri: string;
  sync_status: 'linked' | 'local_only' | 'pending_sync' | 'conflict';
  last_synced: string;
}

export function mergeKoiMetadata(
  existing: Record<string, any>,
  koi: KoiMetadata
): Record<string, any> {
  return {
    ...existing,
    koi: {
      ...existing.koi,
      ...koi
    }
  };
}

export function serializeFrontmatter(frontmatter: Record<string, any>): string {
  // Use yaml library to serialize
  // Preserve quotes around wikilinks: "[[People/Name]]"
  // Handle special characters properly
}
```

#### 4.2 Safe Note Update

**Critical:** Only update frontmatter, never rewrite entire file.

```typescript
export async function updateNoteFrontmatter(
  vaultPath: string,
  notePath: string,
  updates: Partial<Record<string, any>>
): Promise<void> {
  // 1. Read full note
  const fullContent = await readFile(join(vaultPath, notePath));

  // 2. Parse frontmatter and body
  const { frontmatter, body, raw } = parseFrontmatter(fullContent);

  // 3. Merge updates into frontmatter only
  const updatedFrontmatter = { ...frontmatter, ...updates };

  // 4. Reconstruct note with updated frontmatter + original body
  const updatedContent = reconstructNote(updatedFrontmatter, body);

  // 5. Write back (using vault_write_note for safety)
  await writeNote(vaultPath, notePath, updatedContent);
}
```

### Phase 5: Testing & Validation

#### 5.1 Test Cases

1. **Register new entity**
   - Create People/Test Person.md with basic frontmatter
   - Run vault_register_entity
   - Verify: backend has entity, note has koi: metadata

2. **Register existing entity (dedup)**
   - Entity already in backend from document extraction
   - Run vault_register_entity for matching vault note
   - Verify: links to existing canonical URI, not duplicate

3. **Bulk sync**
   - Run vault_sync_entities on People/ folder
   - Verify: all registered, stats correct

4. **Content hash change detection**
   - Modify vault note
   - Check sync status
   - Verify: shows as pending_sync

#### 5.2 Validation Script

```bash
# Test registration
curl -X POST http://localhost:8351/register-entity \
  -H "Content-Type: application/json" \
  -d '{
    "vault_rid": "orn:regen.document:obsidian/People/Test-Person",
    "vault_path": "People/Test Person.md",
    "entity_type": "Person",
    "name": "Test Person",
    "properties": {"email": "test@example.com"},
    "content_hash": "sha256:abc123"
  }'

# Check mappings
curl http://localhost:8351/vault-entities
```

## File Changes Summary

### personal-koi-mcp (this repo)

| File | Action | Description |
|------|--------|-------------|
| `src/rid.ts` | **NEW** | RID generation and parsing |
| `src/vault-scanner.ts` | **NEW** | Scan vault for entities |
| `src/frontmatter.ts` | **NEW** | Frontmatter parsing and updates |
| `src/backend-client.ts` | **MODIFY** | Add registerEntity, getVaultEntities |
| `src/tools.ts` | **MODIFY** | Add 3 new tool definitions |
| `src/index.ts` | **MODIFY** | Add handlers for new tools |
| `docs/Obsidian/VAULT_KOI_SYNC.md` | **DONE** | Architecture documentation |

### koi-processor (backend)

| File | Action | Description |
|------|--------|-------------|
| `migrations/XXX_add_rid_mappings.sql` | **NEW** | Database schema for RID mappings |
| `api/personal_ingest_api.py` | **MODIFY** | Add /register-entity, /vault-entities endpoints |

## Implementation Order

1. **Database schema** - Add entity_rid_mappings table ✅
2. **Backend API** - Add /register-entity endpoint ✅
3. **RID module** - Create src/vault-rid.ts ✅
4. **Backend client** - Add registerEntity method ✅
5. **MCP tools** - Add vault_register_entity ✅
6. **Frontmatter update** - Safe YAML updates ✅
7. **Bulk sync** - vault_sync_entities tool ✅
8. **Git backup** - Automatic backup before changes ✅
9. **Incremental sync** - sync_changed mode ✅
10. **Testing** - Validate full flow ✅

## Success Criteria

- [x] Can register a single vault entity and get canonical URI
- [x] Duplicate entities are linked, not duplicated
- [x] Frontmatter is updated with koi: metadata safely
- [x] Bulk sync processes all entities in folder
- [x] Sync status accurately reflects vault vs backend state
- [x] No data loss in frontmatter updates
- [x] Git backup before automatic changes (backup parameter)
- [x] Incremental sync for changed entities only (sync_changed mode)

## Current Status (January 2026)

**252 entities synced:**
- People: 117
- Organizations: 89
- Projects: 26
- Locations: 17
- Concepts: 3

**Sync Modes Available:**
- `register_new` - Only register new entities (default)
- `full_sync` - Re-register all entities
- `sync_changed` - Only sync entities with pending changes (most efficient)
