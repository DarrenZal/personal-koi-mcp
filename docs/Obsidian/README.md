# Obsidian Vault Integration

Documentation for integrating Obsidian vault with personal KOI backend.

## Overview

The personal KOI system enables bidirectional sync between your Obsidian vault (YAML frontmatter) and a local knowledge graph backend. This allows:

- **Entity deduplication**: Same person/org mentioned across documents → single canonical entity
- **RID-based linking**: Stable identifiers that survive file renames and moves
- **Wikilink generation**: Auto-link entity mentions in documents
- **Knowledge graph queries**: Semantic search across your personal knowledge base

## Documentation

| Document | Description |
|----------|-------------|
| [VAULT_KOI_SYNC.md](./VAULT_KOI_SYNC.md) | Architecture and data flow for vault ↔ KOI sync |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Implementation phases and code specifications |

## Quick Reference

### YAML Frontmatter Schema

```yaml
---
"@type": schema:Person
name: Clare Attwell

# KOI sync metadata (auto-populated)
koi:
  rid: "orn:regen.document:obsidian/People/Clare-Attwell"
  canonical_uri: "orn:personal-koi.entity:person-clare-attwell-abc123"
  sync_status: linked
  last_synced: 2026-01-28T12:00:00Z
---
```

### MCP Tools

| Tool | Purpose |
|------|---------|
| `vault_register_entity` | Register single entity note with backend |
| `vault_sync_entities` | Bulk register all entities from folders |
| `vault_check_sync_status` | Check sync status between vault and backend |
| `vault_extract_entities` | Extract entities from document content |
| `vault_ingest_extraction` | Send extracted entities to backend |

### Backend Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register-entity` | POST | Register vault entity, get canonical URI |
| `/vault-entities` | GET | List all registered vault entities |
| `/ingest` | POST | Ingest extracted entities from document |
| `/health` | GET | Check backend status |

## Status

- [x] Architecture documented
- [x] Implementation plan created
- [ ] Phase 1: RID generation
- [ ] Phase 2: Backend registration endpoint
- [ ] Phase 3: MCP tools
- [ ] Phase 4: Frontmatter integration
- [ ] Phase 5: Testing

## Related

- [Personal KOI Plan](~/.claude/plans/jazzy-frolicking-horizon.md)
- [BlockScience KOI Research](/Users/darrenzal/projects/RegenAI/koi-research/sources/blockscience/)
- [koi-processor Backend](/Users/darrenzal/projects/RegenAI/koi-processor/)
