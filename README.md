# Personal KOI MCP Server

Personal knowledge management through Model Context Protocol (MCP). Search your emails, Obsidian vault, and Claude Code sessions with semantic search.

## What This Does

| Source | Count | Features |
|--------|-------|----------|
| **Emails** | 13,400+ | Semantic search, sender/date filtering |
| **Obsidian Vault** | Your notes | Entity extraction, wikilink parsing |
| **Claude Sessions** | 260+ | Search past conversations |

## Quick Start

### 1. Prerequisites

- Personal KOI API running on port 8351
- BGE embedding server on port 8091
- PostgreSQL database `personal_koi`

This local stack does not share Octo's database. It uses its own KOI backend deployment and `personal_koi` DB, even though that backend comes from the same `koi-processor` codebase family used by the bioregional nodes.

```bash
# Start the backend
~/.config/personal-koi/start.sh
```

### 2. Configure Claude Code

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "personal-koi": {
      "command": "node",
      "args": ["/Users/darrenzal/projects/personal-koi-mcp/dist/index.js"],
      "env": {
        "KOI_API_ENDPOINT": "http://localhost:8351",
        "KOI_BACKEND_URL": "http://localhost:8351",
        "MCP_SERVER_NAME": "personal-koi"
      }
    }
  }
}
```

Enable in `~/.claude/settings.local.json`:
```json
{
  "enabledMcpjsonServers": ["personal-koi"]
}
```

### 3. Restart Claude Code

## Available Tools

### Knowledge Search

| Tool | Description |
|------|-------------|
| `recall` | **(preferred)** Routing-aware retrieval: KOI hybrid for semantic queries, KOI-native PostgreSQL recursive-CTE walk for temporal/relationship queries. Per Tier-2 Strand A4 (Tier-3 backend port 2026-04-29). |
| `unified_search` | **DEPRECATED** — prefer `recall(query)`. Remains functional during 4-week deprecation window (target removal: 2026-05-26 second Tier-2 production review). KOI semantic-only retrieval. |
| `search` | Semantic search across emails, vault, sessions |
| `get_stats` | Statistics about indexed content |

**Examples:**
```
recall(query="When did F2 transition from candidate to decline-with-triggers?")  # auto → temporal → KOI walk
recall(query="canon-review v1 wiki intake retrospective")                          # auto → semantic → KOI hybrid
recall(query="herring habitat", shape="semantic")                                  # operator-override
search(query="hackathon", source="email")
```

#### `recall` MCP tool (Tier-3 1.2.0 — 2026-04-29)

Routes by query shape:
- `semantic`     → KOI hybrid retrieval (`/knowledge/unified-search` over entities/facts/sessions/wiki/vault)
- `temporal`     → KOI recursive-CTE walk (`/knowledge/recall-walk` over `knowledge_facts` with `valid_to IS NULL`)
- `relationship` → KOI recursive-CTE walk (same backend; expired edges included with `expired: true`)

**Tier-3 architectural correction (1.2.0)**: previously the temporal/relationship leg routed to a Graphiti FalkorDB sidecar; that sidecar is being retired (Phase 9 tear-out scheduled tomorrow after overnight bake-in). The replacement walks the existing PostgreSQL `knowledge_facts` table (bi-temporal `valid_from`/`valid_to`, embedded fact text, episode anchoring, idempotent dedup with cosine>0.95 supersession). Single-substrate now.

Failure semantics:
- KOI unreachable → returns `error_code: "substrate_unavailable"` (both legs share the substrate).
- KOI walk endpoint error → falls back to `/knowledge/unified-search`; response carries `routing.shape_source = "fallback"`. Not an error to caller.

**Revert mechanisms**:
- `RECALL_BACKEND=graphiti` — explicit revert to FalkorDB sidecar (still alive through Phase 9 tomorrow). Flip-flop is hot — env var is read per-call by the recall handler; no MCP-server-process restart required.
- `RECALL_ROUTING_ENABLED=false` — disables shape routing entirely; all queries forced to KOI hybrid (`legs_queried=["koi"]`, `shape_source="fallback"`).

Per-call observability: every invocation appends a JSON line to `~/.koi/logs/recall-metrics.jsonl`.

### Vault Operations

| Tool | Description |
|------|-------------|
| `vault_read_note` | Read an Obsidian note |
| `vault_write_note` | Create/update a note |
| `vault_list_notes` | List notes by folder |
| `vault_search_notes` | Search note content |
| `vault_get_entity` | Look up entity by type + name |
| `vault_prep_meeting` | Gather context for meeting attendees |

### Session Search

| Tool | Description |
|------|-------------|
| `search_sessions` | Search Claude Code conversation history |
| `get_session_stats` | Statistics about indexed sessions |
| `search_sessions_by_tool` | Find sessions using specific tools |
| `search_sessions_by_files` | Find sessions touching specific files |

### KOI Federation Sharing (P2P + Commons)

| Tool | Description |
|------|-------------|
| `share_document` | Share a vault doc to a KOI node alias with rich modes (`root_only`, `root_plus_required`, `context_pack`) |
| `shared_with_me` | List inbound shared docs and share metadata |
| `commons_intake` | List staged/approved/rejected commons intake records |
| `commons_intake_decide` | Approve/reject staged commons intake entries (local admin auth) |

Key `share_document` args:
- `recipient` — node alias or node name (for example `shawn`, `cowichan`)
- `recipient_type` — `peer` (default) or `commons`
- `mode` — `root_only`, `root_plus_required`, or `context_pack`
- `context_depth` — traversal depth (1-4)

Example:
```javascript
share_document({
  document_path: "projects/koi-protocol-comparison.md",
  recipient: "cowichan",
  recipient_type: "commons",
  mode: "context_pack",
  context_depth: 2
})
```

### Entity Resolution

| Tool | Description |
|------|-------------|
| `resolve_entity` | Find or create entity in personal KB |
| `get_entity_neighborhood` | Get entity relationships |
| `vault_ingest_extraction` | Ingest entities with contextual resolution |
| `vault_sync_entities` | Sync vault entity folders to backend |

**Contextual Resolution** (Tier 1.5):
- Pass `context.organizations` and `context.project` for disambiguation
- Per-entity `associated_people`/`associated_organizations` fields
- Phonetic matching for name variants (Sean → Shawn)
- 2-hop relationship paths: Person → Org → Project

```javascript
// Example: Resolve ambiguous name with context
vault_ingest_extraction({
  path: "Meetings/My Meeting.md",
  entities: [{
    name: "Sean Anderson",
    type: "Person",
    associated_organizations: ["Symbiocene Labs"]
  }],
  context: {
    organizations: ["Symbiocene Labs"],
    project: "Gaia AI"
  }
})
// Result: Resolves to "Shawn Anderson" @ 93.4% confidence
```

### Task Management

| Tool | Description |
|------|-------------|
| `task_dashboard` | Summary stats + inbox preview |
| `task_list` | List tasks with filters (status, priority, owner, due date) |
| `task_add` | Create/upsert a task (idempotent by taskKey) |
| `task_update` | Patch specific fields on an existing task |

### Dynamic Query

| Tool | Description |
|------|-------------|
| `koi_query` | Execute read-only SQL against the knowledge graph (10-table whitelist, parameterized queries only) |

The `koi_query` tool enables arbitrary SELECT queries with `$1,$2` parameterized values. Defense-in-depth: client-side SELECT/WITH pre-validation, server-side table whitelist, read-only transaction, 5s timeout, parameterization enforcement. Requires `QUERY_ENDPOINT_ENABLED=true` on the backend (`POST /sql` endpoint).

### Claims Engine

| Tool | Description |
|------|-------------|
| `create_claim` | Create impact claim (entity registered in graph) |
| `get_claim` | Get claim with linked evidence |
| `search_claims` | Search by type, claimant, verification state |
| `verify_claim` | Advance verification: self_reported → peer_reviewed → verified → ledger_anchored |
| `link_evidence` | Attach evidence entity to claim |
| `extract_claims` | AI extraction of claims from document text |
| `anchor_claim` | Anchor verified claim on Regen Ledger (returns 202 pending for async polling) |
| `reconcile_claim` | Check on-chain status of pending broadcast |

**Testing:**
```bash
npm run test:claims  # 8-tool MCP smoke test via handleKoiApiTool()
```

## Architecture

This local setup is a 3-repository stack:
- `koi-sensors` for data ingestion (`email`, `claude_sessions`, vault/sensor pipelines)
- `koi-processor` for storage and query endpoints on `http://localhost:8351`
- `personal-koi-mcp` for MCP tools consumed by Claude Code

The backend here is a separate deployment of the same KOI backend codebase used by the bioregional nodes. What is shared is the code and API contract, not the live database or runtime instance.

Runbook: [`docs/LOCAL_STACK_RUNBOOK.md`](docs/LOCAL_STACK_RUNBOOK.md)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Personal KOI System                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐                ┌────────────────────────┐ │
│  │  personal-koi    │ ◀─────────────▶│  Personal KOI API      │ │
│  │  MCP Server      │                │  (port 8351)           │ │
│  └──────────────────┘                └────────────────────────┘ │
│                                               │                  │
│                                               ▼                  │
│                                      ┌────────────────────────┐ │
│                                      │  PostgreSQL            │ │
│                                      │  personal_koi DB       │ │
│                                      │  - koi_memories        │ │
│                                      │  - koi_embeddings      │ │
│                                      │  - email_metadata      │ │
│                                      │  - session_chunks      │ │
│                                      └────────────────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Data Ingestion                         │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                           │   │
│  │  ┌──────────────┐  Periodic (30 min)  ┌───────────────┐  │   │
│  │  │ Email Sensor │ ──────────────────▶ │ koi_memories  │  │   │
│  │  └──────────────┘                     └───────────────┘  │   │
│  │                                                           │   │
│  │  ┌──────────────┐  Real-time (fswatch)                   │   │
│  │  │ File Watcher │ ─────────────────────────────────────▶ │   │
│  │  └──────────────┘                                        │   │
│  │                                                           │   │
│  │  ┌──────────────┐  On-demand                             │   │
│  │  │Session Sensor│ ─────────────────────────────────────▶ │   │
│  │  └──────────────┘                                        │   │
│  │                                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Email Sync System

Emails are kept updated through two mechanisms:

### Periodic Sync (launchd)
- Runs every 30 minutes
- Fetches new emails from `~/Mail/Gmail/` (Maildir via mbsync)
- Generates BGE embeddings and stores in PostgreSQL

```bash
# Check status
launchctl list com.personal-koi.email-sensor

# View logs
tail -f ~/projects/RegenAI/koi-sensors/sensors/email/email_sensor.log
```

### Real-time Watcher (launchd)
- Watches Maildir for new files
- Triggers immediate indexing when new emails arrive

```bash
# Check status
launchctl list com.personal-koi.email-watcher
```

### Manual Sync

To manually trigger a sync:
```bash
cd ~/projects/RegenAI/koi-sensors/sensors/email
./venv/bin/python email_sensor.py
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run directly
npm start
```

## Related Projects

- **[koi-processor](https://github.com/gaiaaiagent/koi-processor)** - Backend API and processing
- **[koi-sensors](https://github.com/gaiaaiagent/koi-sensors)** - Email and vault sensors
- **[regen-koi-mcp](https://github.com/gaiaaiagent/regen-koi-mcp)** - Original Regen Network KOI MCP (this is a fork)

## Differences from regen-koi-mcp

| Feature | regen-koi-mcp | personal-koi-mcp |
|---------|---------------|------------------|
| **Data** | Regen Network (Discourse, GitHub, Notion) | Personal (emails, vault, sessions) |
| **API** | `https://regen.gaiaai.xyz/api/koi` | `http://localhost:8351` |
| **Embeddings** | OpenAI ada-002 (1536-dim) | BGE (1024-dim) |
| **Auth** | Google OAuth for @regen.network | None required |
| **Vault tools** | ❌ | ✅ |
| **Session search** | ❌ | ✅ |

## License

MIT
