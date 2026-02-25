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
| `search` | Semantic search across emails, vault, sessions |
| `get_stats` | Statistics about indexed content |

**Examples:**
```
search(query="hackathon", source="email")
search(query="regen network carbon credits")
```

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

## Architecture

This local setup is a 3-repository stack:
- `koi-sensors` for data ingestion (`email`, `claude_sessions`, vault/sensor pipelines)
- `koi-processor` for storage and query endpoints on `http://localhost:8351`
- `personal-koi-mcp` for MCP tools consumed by Claude Code

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
