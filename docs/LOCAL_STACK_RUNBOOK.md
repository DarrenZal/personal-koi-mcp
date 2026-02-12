# Local KOI Stack Runbook

This runbook covers the local 3-repository setup:

- `koi-sensors` (data collection)
- `koi-processor` (storage + query API)
- `personal-koi-mcp` (MCP tool interface)

## 1. Start Order

1. Start `koi-processor` services (`personal_ingest_api`, DB, embedding service as needed).
2. Start personal sensors in `koi-sensors`:
   - `sensors/email`
   - `sensors/claude_sessions`
3. Start or build `personal-koi-mcp`.

## 2. Sensor Commands

From `koi-sensors`:

```bash
# Email sensor (daemon)
cd sensors/email
./setup.sh
./start.sh --background

# Claude sessions sensor (daemon)
cd ../claude_sessions
./setup.sh
./start.sh --background
```

Or from repository root:

```bash
ENABLE_PERSONAL_SENSORS=true ./setup_all.sh
ENABLE_PERSONAL_SENSORS=true ./start_all.sh
```

## 3. Health Checks

### Processor/API

```bash
curl -s http://localhost:8351/health || true
```

### Session endpoints

```bash
curl -s http://localhost:8351/session-stats
curl -s "http://localhost:8351/session-tools"
curl -s "http://localhost:8351/session-files?limit=5"
```

### MCP-facing checks

- `search(query="...", source="email")`
- `get_session_stats()`
- `search_sessions(query="...")`

## 4. Expected Failure Modes

- API unavailable (`localhost:8351` down): MCP returns backend-unavailable errors.
- Email migration missing (`033_email_sensor_tables.sql` not run): email metadata lookups fail.
- Session sensor not run: session tools return no results.
- Missing `OPENAI_API_KEY`: session embeddings are skipped (metadata ingestion still works).

## 5. Source Sensor Conventions

- Email content source sensor: `email-sensor`
- Claude sessions source sensor: `claude-sessions-sensor` (metadata contract)

These identifiers should stay stable across sensors, processor filters, and MCP docs.
