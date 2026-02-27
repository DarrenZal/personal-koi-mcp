# Vault ↔ KOI Sync Architecture

This document describes how Obsidian vault notes sync with the personal KOI backend using the RID (Resource Identifier) system from BlockScience's KOI research.

## Overview

The personal KOI system creates a **bidirectional sync** between:
- **Obsidian Vault**: Markdown files with YAML frontmatter (your local knowledge)
- **KOI Backend**: PostgreSQL database with entity registry and relationships

The key insight from KOI research: **Reference ≠ Referent**
- A **RID** (Resource Identifier) is a *reference* to something
- The **entity** is the *referent* (the actual person, org, concept)
- Multiple RIDs can point to the same entity

## RID System

### What is a RID?

A RID is a stable identifier that can reference resources across different systems:

```
orn:regen.document:obsidian/People-Clare-Attwell   ← Your vault note
orn:regen.document:notion/page-abc123              ← Metagov canonical record
orn:slack.user:TA2E6KPK3/U123456                   ← Slack user
```

All three RIDs can refer to the **same person** (Clare Attwell).

### RID Format

```
orn:<namespace>.<type>:<source>/<path>

Examples:
orn:personal-koi.entity:person-clare-attwell-abc123    ← Backend canonical
orn:regen.document:obsidian/People/Clare-Attwell      ← Vault note RID
orn:regen.document:notion/page-f47ac10b               ← External source
```

### Multi-Source Entity Resolution

When the same entity appears in multiple places:

```
┌─────────────────────────────────────────────────────────────┐
│                     Entity: Clare Attwell                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Vault RID                    Backend Canonical URI          │
│  orn:regen.document:         orn:personal-koi.entity:       │
│    obsidian/People/            person-clare-attwell-        │
│    Clare-Attwell        ←──→   abc123                       │
│                                                              │
│  External RIDs (optional):                                   │
│  - orn:regen.document:notion/page-abc123                    │
│  - orn:slack.user:TA2E6KPK3/U123456                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

The graph stores relationships:
```
(vault-rid) -[refers_to_same_entity]-> (canonical-uri)
(external-rid) -[refers_to_same_entity]-> (canonical-uri)
```

## YAML Frontmatter Schema

### Entity Notes (People, Organizations, etc.)

```yaml
---
# Type declaration (schema.org compatible)
"@type": schema:Person

# Local vault identifier
"@id": people/clare-attwell

# Core properties
name: Clare Attwell
email: clare@example.com
affiliation: "[[Organizations/Regen Network]]"

# KOI sync metadata (added by system)
koi:
  rid: "orn:regen.document:obsidian/People/Clare-Attwell"
  canonical_uri: "orn:personal-koi.entity:person-clare-attwell-abc123"
  sync_status: linked    # linked | local_only | pending_sync
  last_synced: 2026-01-28T12:00:00Z

# External references (optional)
external_rids:
  - source: notion
    rid: "orn:regen.document:notion/page-abc123"
    last_synced: 2026-01-28
  - source: slack
    rid: "orn:slack.user:TA2E6KPK3/U123456"
---
```

### Sync Status Values

| Status | Meaning |
|--------|---------|
| `linked` | Vault note is synced with backend entity |
| `local_only` | Vault note exists but not registered in backend |
| `pending_sync` | Changes made, waiting to sync to backend |
| `conflict` | Local and backend have diverged |

### Document Notes (Meetings, Articles, etc.)

```yaml
---
"@type": Meeting
date: 2026-01-28
project: GAIA

# Entities mentioned (wikilinks become RID references)
attendees:
  - "[[People/Clare Attwell]]"
  - "[[People/Gregory Landua]]"

# KOI extraction metadata
koi:
  rid: "orn:regen.document:obsidian/Meetings/2026-01-28-GAIA-Meeting"
  extracted_entities:
    - uri: "orn:personal-koi.entity:person-clare-attwell-abc123"
      mentions: 5
    - uri: "orn:personal-koi.entity:person-gregory-landua-def456"
      mentions: 3
  last_processed: 2026-01-28T14:30:00Z
---
```

## Data Flow

### 1. Vault → Backend (Entity Registration)

When you create or update an entity note:

```
People/Clare Attwell.md (created/updated)
         │
         ▼
    Parse YAML frontmatter
         │
         ▼
    Generate vault RID:
    orn:regen.document:obsidian/People/Clare-Attwell
         │
         ▼
    Create Bundle:
    {
      rid: "orn:regen.document:obsidian/People/Clare-Attwell",
      manifest: { timestamp, content_hash },
      contents: { @type, name, email, ... }
    }
         │
         ▼
    POST /register-entity to backend
         │
         ▼
    Backend:
    - Deduplicates against existing entities
    - Creates/returns canonical URI
    - Stores vault RID → canonical mapping
         │
         ▼
    Update vault note frontmatter:
    koi:
      canonical_uri: "orn:personal-koi.entity:person-..."
      sync_status: linked
```

### 2. Document Processing (Entity Extraction)

When you process a document for entity linking:

```
Articles/Salish Sea Herring.md
         │
         ▼
    Claude extracts entities from content:
    ["DFO", "Amanda Bates", "Salish Sea", ...]
         │
         ▼
    POST /ingest to backend
         │
         ▼
    Backend resolves each entity:
    - Tier 1: Exact match
    - Tier 1.x: Fuzzy match
    - Tier 2: Semantic match (embeddings)
    - Tier 3: Create new
         │
         ▼
    Returns canonical URIs for each entity
         │
         ▼
    Map URIs to vault paths for wikilinks
         │
         ▼
    Update document with wikilinks
```

### 3. Backend → Vault (Optional Sync)

When canonical data changes externally:

```
Backend receives update from external source
         │
         ▼
    Find linked vault RIDs
         │
         ▼
    Compare with vault note content
         │
         ▼
    If different:
    - Set sync_status: conflict
    - Or auto-merge if configured
```

## API Endpoints

### POST /register-entity

Register a vault entity note in the backend.

**Request:**
```json
{
  "vault_rid": "orn:regen.document:obsidian/People/Clare-Attwell",
  "entity_type": "Person",
  "name": "Clare Attwell",
  "properties": {
    "email": "clare@example.com",
    "affiliation": "Regen Network"
  },
  "content_hash": "sha256:abc123...",
  "source": "obsidian-vault"
}
```

**Response:**
```json
{
  "success": true,
  "canonical_uri": "orn:personal-koi.entity:person-clare-attwell-abc123",
  "is_new": false,
  "merged_with": null,
  "collision_warning": null,
  "vault_rid": "orn:regen.document:obsidian/People/Clare-Attwell"
}
```

### POST /ingest

Ingest extracted entities from a document (existing endpoint).

### GET /entity/{uri}

Get entity details including all linked RIDs.

**Response:**
```json
{
  "canonical_uri": "orn:personal-koi.entity:person-clare-attwell-abc123",
  "entity_text": "Clare Attwell",
  "entity_type": "Person",
  "linked_rids": [
    {
      "rid": "orn:regen.document:obsidian/People/Clare-Attwell",
      "source": "obsidian-vault",
      "last_synced": "2026-01-28T12:00:00Z"
    }
  ],
  "properties": {
    "email": "clare@example.com"
  }
}
```

### GET /vault-entities

List all entities registered from the vault.

**Response:**
```json
{
  "entities": [
    {
      "vault_rid": "orn:regen.document:obsidian/People/Clare-Attwell",
      "vault_path": "People/Clare Attwell.md",
      "canonical_uri": "orn:personal-koi.entity:person-...",
      "sync_status": "linked"
    }
  ],
  "count": 42
}
```

## MCP Tools

### vault_register_entity

Register a single vault entity note with the backend.

```typescript
vault_register_entity({
  path: "People/Clare Attwell.md"
})
// Returns: canonical_uri, sync_status
```

### vault_sync_entities

Bulk sync all entity notes from specified folders.

```typescript
vault_sync_entities({
  folders: ["People", "Organizations", "Projects"],
  mode: "register_new"  // or "full_sync"
})
// Returns: { registered: 10, updated: 5, conflicts: 0 }
```

### vault_check_sync_status

Check sync status for vault entities.

```typescript
vault_check_sync_status({
  folder: "People"
})
// Returns: list of entities with sync_status
```

## Database Schema

### entity_rid_mappings

Links vault RIDs to canonical URIs.

```sql
CREATE TABLE entity_rid_mappings (
  id SERIAL PRIMARY KEY,
  vault_rid VARCHAR(500) NOT NULL UNIQUE,
  vault_path VARCHAR(500) NOT NULL,
  canonical_uri VARCHAR(500) NOT NULL REFERENCES entity_registry(fuseki_uri),
  content_hash VARCHAR(100),
  sync_status VARCHAR(20) DEFAULT 'linked',
  last_synced TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_sync_status CHECK (
    sync_status IN ('linked', 'local_only', 'pending_sync', 'conflict')
  )
);

CREATE INDEX idx_rid_mappings_canonical ON entity_rid_mappings(canonical_uri);
CREATE INDEX idx_rid_mappings_vault_path ON entity_rid_mappings(vault_path);
```

## Configuration

### personal-koi config.json

```json
{
  "backend": {
    "url": "http://localhost:8351",
    "timeout_ms": 30000
  },
  "vault": {
    "path": "/Users/darrenzal/Documents/Notes",
    "entity_folders": ["People", "Organizations", "Projects", "Locations", "Concepts"],
    "auto_sync": false,
    "sync_on_save": false
  },
  "rid": {
    "namespace": "regen.document",
    "source": "obsidian"
  }
}
```

## Future: Federation with Regen KOI

Once personal KOI-net is stable:

1. **Selective sharing**: Mark entities for sharing with `share_to_regen: true`
2. **Event emission**: Send `NEW`/`UPDATE` events to Regen KOI node
3. **Canonical resolution**: Link local entities to Regen's canonical records
4. **Bidirectional sync**: Receive updates from Regen for shared entities

```yaml
# Future frontmatter extension
koi:
  rid: "orn:regen.document:obsidian/People/Clare-Attwell"
  canonical_uri: "orn:personal-koi.entity:person-clare-attwell-abc123"
  sync_status: linked
  share_to_regen: true
  regen_uri: "orn:regen.entity:person-clare-attwell-xyz789"
```

## References

- [BlockScience KOI Research](https://github.com/metagov/koi-research)
- [KOI Protocol Specification](../koi-research/sources/blockscience/)
- [Personal KOI Plan](~/.claude/plans/jazzy-frolicking-horizon.md)
