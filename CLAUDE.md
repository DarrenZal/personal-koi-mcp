# CLAUDE.md - Personal KOI MCP Server

This file provides guidance to Claude Code when working on the personal-koi-mcp project.

## Project Overview

Personal KOI MCP Server extends the Regen KOI infrastructure with local Obsidian vault integration. It provides:
1. All original Regen KOI tools (search, graph queries, etc.)
2. **NEW: Local vault tools** for reading/writing Obsidian notes

## Key Additions from regen-koi-mcp

### Vault Tools

| Tool | Description |
|------|-------------|
| `vault_read_note` | Read a note from local Obsidian vault |
| `vault_write_note` | Create/update a note with optional frontmatter |
| `vault_list_notes` | List notes by folder or entity type |
| `vault_search_notes` | Search notes by query |
| `vault_get_entity` | Quick lookup by entity type + name |
| `vault_prep_meeting` | Gather context about meeting attendees |

### New Files

- `src/vault.ts` - Vault operations (read, write, parse YAML frontmatter)
- Added vault tool definitions in `src/tools.ts`
- Added vault handlers in `src/index.ts`

## Configuration

Set your vault path:
```bash
export OBSIDIAN_VAULT_PATH=~/Documents/Notes
```

## Development

```bash
# Install dependencies (includes yaml package)
npm install

# Build
npm run build

# Run
npm start
```

## Expected Vault Structure

The vault tools work best with notes that have YAML frontmatter using schema.org types:

```yaml
---
"@type": schema:Person
"@id": people/john-smith
name: John Smith
affiliation: [[Acme Corp]]
---
```

### Supported Entity Types
- `Person` - People notes (expected in `People/` folder)
- `Organization` - Company/org notes
- `Meeting` - Meeting notes with attendees, action items
- `Project` - Project tracking notes

### Relationship Extraction

The vault parser extracts:
- `[[wikilinks]]` as `mentions` relationships
- `affiliation` field as `affiliatedWith`
- `attendees` field as `hasAttendee`
- `project` field as `relatedToProject`

## Integration with KOI Sensor

This MCP works alongside the Obsidian sensor in koi-sensors:
- **Sensor**: Watches vault, emits changes to KOI processor for graph indexing
- **MCP**: Provides direct vault access + KOI graph queries

## Usage Examples

```
# Read a note
vault_read_note(path="People/John Smith")

# Write a new person note
vault_write_note(
  path="People/Jane Doe",
  content="# Jane Doe\n\nWorks at [[Acme Corp]].",
  frontmatter={"@type": "schema:Person", "name": "Jane Doe"}
)

# List all meetings
vault_list_notes(folder="Meetings", limit=20)

# Prep for meeting
vault_prep_meeting(attendees=["John Smith", "Jane Doe"], project="Project X")
```

## Related Projects

- **koi-sensors/sensors/obsidian**: Sensor that indexes vault to KOI graph
- **MycoMind**: AI entity extraction and graph DB tools
- **regen-koi-mcp**: Original Regen KOI MCP (this is a fork)
