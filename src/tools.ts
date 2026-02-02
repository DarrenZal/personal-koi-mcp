/**
 * Tool definitions for Regen KOI MCP Server
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { GRAPH_TOOL } from './graph_tool.js';

export const TOOLS: Tool[] = [
  GRAPH_TOOL,
  {
    name: 'search',
    description: `Search the Regen Network knowledge base. Supports:
- Hybrid search (vector + graph + keyword) with entity boosting
- Intent-aware retrieval for better results on specific query types
- Date filtering with published_from/published_to
- Source filtering (notion, github, discourse, etc.)
- Date sorting (relevance, date_desc, date_asc)

**IMPORTANT - Use the intent parameter for better results:**
- For "what is X working on" or "what has X done" queries about a person → use intent="person_activity"
- For "who is X" or biography questions → use intent="person_bio"
- For "how do I" or technical implementation questions → use intent="technical_howto"
- For general searches → omit intent or use intent="general"

Example: Get what Gregory Landua is working on:
  search(query="Gregory Landua", intent="person_activity", limit=15)

Example: Get latest 5 Notion docs:
  search(query="*", source="notion", sort_by="date_desc", limit=5)

NOT for live blockchain queries - use Ledger MCP for on-chain state.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "carbon credits", "Regen Registry governance")'
        },
        intent: {
          type: 'string',
          enum: ['general', 'person_activity', 'person_bio', 'technical_howto', 'concept_explain'],
          description: 'Query intent for optimized retrieval. Use "person_activity" for "what is X working on" queries (finds docs authored by the person). Use "person_bio" for "who is X" queries. Use "technical_howto" for implementation questions. Default: "general"',
          default: 'general'
        },
        source: {
          type: 'string',
          description: "Filter by source type (e.g., 'notion', 'github', 'discourse'). Supports partial matching - 'discourse' matches 'discourse:forum.regen.network'. Use get_stats to see available sources."
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 50)',
          minimum: 1,
          maximum: 50,
          default: 10
        },
        published_from: {
          type: 'string',
          format: 'date',
          description: 'Filter: include only content published on/after this date (YYYY-MM-DD)'
        },
        published_to: {
          type: 'string',
          format: 'date',
          description: 'Filter: include only content published on/before this date (YYYY-MM-DD)'
        },
        include_undated: {
          type: 'boolean',
          description: 'When using a date filter, also include documents with no known publication date',
          default: false
        },
        sort_by: {
          type: 'string',
          enum: ['relevance', 'date_desc', 'date_asc'],
          description: "Sort order: 'relevance' (default) for weighted hybrid score, 'date_desc' for newest first, 'date_asc' for oldest first. Documents with null dates appear last when sorting by date.",
          default: 'relevance'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_stats',
    description: 'Get statistics about the KOI knowledge base including document counts, data sources, and recent updates',
    inputSchema: {
      type: 'object',
      properties: {
        detailed: {
          type: 'boolean',
          description: 'Include detailed breakdown by source and type',
          default: false
        }
      }
    }
  },
  {
    name: 'generate_weekly_digest',
    description: 'Generate a weekly digest SUMMARY of Regen Network activity. **Sources aggregated:** Discourse forum discussions, GitHub activity (commits, PRs, issues), on-chain governance proposals and votes, credit issuance/retirement metrics, and community channels (Discord, Telegram summaries). **Output:** Curated markdown brief with executive summary, governance analysis, community discussions, and on-chain metrics. **Use cases:** Weekly team updates, stakeholder briefings, catching up on ecosystem activity, monitoring governance. This is a condensed overview - use get_notebooklm_export for full content with complete forum posts and Notion pages.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          format: 'date',
          description: 'Start date for digest period (YYYY-MM-DD). Defaults to 7 days ago. Use with end_date to specify custom date ranges (e.g., monthly digest, quarterly review).'
        },
        end_date: {
          type: 'string',
          format: 'date',
          description: 'End date for digest period (YYYY-MM-DD). Defaults to today. Typically used with start_date for custom ranges.'
        },
        save_to_file: {
          type: 'boolean',
          description: 'Whether to save the digest to a file on disk. Useful for archiving or sharing. Default: false',
          default: false
        },
        output_path: {
          type: 'string',
          description: 'Custom file path for saving (only used if save_to_file is true). Defaults to timestamped filename (weekly_digest_YYYY-MM-DD.md) in current directory.'
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output format. markdown: Human-readable report with sections. json: Structured data for programmatic use. Default: markdown',
          default: 'markdown'
        }
      }
    }
  },
  {
    name: 'get_notebooklm_export',
    description: 'Get the full NotebookLM export with COMPLETE content including: full forum thread posts, complete Notion page content (all chunks), enriched URLs, and detailed source material. Automatically saves to a local file to avoid bloating LLM context. Returns the file path and summary stats.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description: 'Custom file path for saving. Defaults to notebooklm_export_YYYY-MM-DD.md in the current directory.'
        }
      }
    }
  },
  {
    name: 'search_github_docs',
    description: 'Search Regen Network GitHub repositories for documentation, README files, configuration files, and technical content. Searches regen-ledger (blockchain), regen-web (frontend), regen-data-standards (schemas), and regenie-corpus (docs). Searches docs only - use Ledger MCP for on-chain data.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "ecocredit module", "validator setup", "governance voting")'
        },
        repository: {
          type: 'string',
          description: 'Optional: Filter by specific repo. Omit to search all 4 repositories.',
          enum: ['regen-ledger', 'regen-web', 'regen-data-standards', 'regenie-corpus']
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          default: 10,
          description: 'Maximum number of results to return'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_repo_overview',
    description: 'Get a structured overview of a specific Regen Network repository including description, key files (README, CONTRIBUTING, etc.), and links to documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: {
          type: 'string',
          description: 'Repository to get overview for',
          enum: ['regen-ledger', 'regen-web', 'regen-data-standards', 'regenie-corpus']
        }
      },
      required: ['repository']
    }
  },
  {
    name: 'get_tech_stack',
    description: 'Get technical stack information for Regen Network repositories including languages, frameworks, dependencies, build tools, and infrastructure. Can show all repos or filter to a specific one.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: {
          type: 'string',
          description: 'Optional: Filter to specific repo. Omit to show all repositories.',
          enum: ['regen-ledger', 'regen-web', 'regen-data-standards', 'regenie-corpus']
        }
      }
    }
  },
  {
    name: 'get_mcp_metrics',
    description: 'Get MCP server performance metrics, cache statistics, and health status. Useful for monitoring and debugging. Returns uptime, tool latencies, cache hit rates, error counts, and circuit breaker status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'regen_koi_authenticate',
    description: 'Authenticate with your @regen.network email to access internal Regen Network documentation in addition to public sources. Opens a browser window for secure OAuth login. Authentication token is saved on the server and persists across sessions. Only needs to be done once.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'resolve_entity',
    description: `Resolve an ambiguous label to a canonical KOI entity. Returns ranked matches with URIs, types, and confidence scores. Use this when you have a label (like "ethereum" or "regen commons") and need to find the exact entity in the knowledge graph.

**Context-aware resolution:** For Organizations, you can provide associated_people to improve disambiguation. If "Biocene Labs" appears with "Shawn Anderson" and "Darren Zal", it may resolve to "Symbiocene Labs" based on document co-occurrence.`,
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'The label to resolve (e.g., "ethereum", "notion", "regen commons")'
        },
        type_hint: {
          type: 'string',
          description: 'Optional type hint to narrow results (e.g., "TECHNOLOGY", "ORGANIZATION", "PERSON")'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
          minimum: 1,
          maximum: 20,
          default: 5
        },
        context: {
          type: 'object',
          description: 'Disambiguation context from surrounding text. Enables Tier 1.5 contextual matching for Organizations.',
          properties: {
            associated_people: {
              type: 'array',
              items: { type: 'string' },
              description: 'People mentioned alongside this entity (e.g., ["Shawn Anderson", "Darren Zal"]). Requires ≥2 people for contextual matching.'
            },
            associated_orgs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Organizations mentioned alongside this entity (reserved for future use)'
            },
            source_text: {
              type: 'string',
              description: 'The sentence or paragraph containing the entity (reserved for future use)'
            }
          }
        }
      },
      required: ['label']
    }
  },
  {
    name: 'get_entity_neighborhood',
    description: 'Get the graph neighborhood of an entity - its direct relationships and connected entities. Returns edges with predicates (like "mentions", "relates_to") and neighboring nodes. Useful for understanding context and connections.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Entity label to look up (will be resolved if ambiguous)'
        },
        uri: {
          type: 'string',
          description: 'Entity URI (preferred if known, e.g., from resolve_entity)'
        },
        type_hint: {
          type: 'string',
          description: 'Optional type hint for disambiguation'
        },
        direction: {
          type: 'string',
          enum: ['out', 'in', 'both'],
          description: 'Edge direction: "out" (entity→neighbors), "in" (neighbors→entity), or "both" (default)',
          default: 'both'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of edges to return (default: 20)',
          minimum: 1,
          maximum: 100,
          default: 20
        }
      }
    }
  },
  {
    name: 'get_entity_documents',
    description: 'Get documents associated with an entity. Returns document references (chunks) that mention or relate to the entity. Respects privacy: unauthenticated requests only see public documents.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Entity label to look up'
        },
        uri: {
          type: 'string',
          description: 'Entity URI (preferred if known)'
        },
        type_hint: {
          type: 'string',
          description: 'Optional type hint for disambiguation'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of documents to return (default: 10)',
          minimum: 1,
          maximum: 50,
          default: 10
        }
      }
    }
  },
  // =============================================================================
  // SPARQL Power Tools (MCP-only)
  // =============================================================================
  {
    name: 'sparql_query',
    description: 'Execute raw SPARQL queries against the Regen Knowledge Graph (Apache Jena). Power tool for advanced graph investigations. Use for complex queries not covered by other tools. Prefer /api/koi/graph for simple entity lookups or /api/koi/entity for resolving labels.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The SPARQL query to execute. Must be a valid SELECT query. PREFIX declarations are optional (common prefixes auto-added).'
        },
        format: {
          type: 'string',
          enum: ['json', 'table'],
          description: 'Output format: "json" for structured data, "table" for human-readable rendering. Default: json',
          default: 'json'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of result rows to return (default: 100, max: 1000). Overrides LIMIT in query if lower.',
          minimum: 1,
          maximum: 1000,
          default: 100
        },
        timeout_ms: {
          type: 'number',
          description: 'Query timeout in milliseconds (default: 30000, max: 60000)',
          minimum: 1000,
          maximum: 60000,
          default: 30000
        }
      },
      required: ['query']
    }
  },
  // =============================================================================
  // Anchored Metadata Tools (Session E: Off-chain Metadata Resolution)
  // =============================================================================
  {
    name: 'resolve_metadata_iri',
    description: 'Resolve a Regen metadata IRI via the allowlisted resolver (api.regen.network). Caches results for efficient repeated lookups. Returns resolution details including content hash for integrity verification. Use this to verify metadata exists before deriving metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: {
          type: 'string',
          description: 'The Regen metadata IRI to resolve (e.g., "regen:13toVfvfM5B7yuJqq8h3iVRHp3PKUJ4ABxHyvn4MeUMwwv1pWQGL295.rdf")'
        },
        force_refresh: {
          type: 'boolean',
          description: 'If true, bypass cache and fetch fresh from resolver. Default: false',
          default: false
        }
      },
      required: ['iri']
    }
  },
  {
    name: 'derive_offchain_hectares',
    description: 'Derive project hectares from a Regen metadata IRI with full citation and derivation provenance. Enforces "no citation, no metric" policy - returns blocked=true if derivation is not possible. Only returns hectares when a valid citation can be constructed. Use this for accurate, citeable project size metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: {
          type: 'string',
          description: 'The Regen metadata IRI to derive hectares from (e.g., "regen:13toVfvfM5B7yuJqq8h3iVRHp3PKUJ4ABxHyvn4MeUMwwv1pWQGL295.rdf")'
        },
        force_refresh: {
          type: 'boolean',
          description: 'If true, bypass cache and re-derive from fresh metadata. Default: false',
          default: false
        }
      },
      required: ['iri']
    }
  },
  // =============================================================================
  // RID Tools (KOI-compatible RID model + KB convenience tools)
  // - parse_rid: Protocol-aligned RID parsing per rid-lib spec
  // - kb_rid_lookup, kb_list_rids: KB-specific conveniences (not KOI-net /rids/fetch etc.)
  // =============================================================================
  {
    name: 'parse_rid',
    description: 'Parse a KOI Resource Identifier (RID) into its components per the rid-lib specification. Stateless - no backend call. Returns: valid (boolean), error (string if invalid), scheme, namespace (null for URI schemes), context (<scheme>:<namespace> for ORN/URN, or just <scheme> for URI schemes like https), reference, rid_type (best-effort heuristic - may be null), uri_components (for HTTP/HTTPS), source_inferred (e.g., "github", "notion" - heuristic).',
    inputSchema: {
      type: 'object',
      properties: {
        rid: {
          type: 'string',
          description: 'The RID string to parse (e.g., "orn:regen.document:notion/page-abc123", "orn:slack.message:TEAM/CHANNEL/TS", "https://github.com/regen-network/regen-ledger")'
        }
      },
      required: ['rid']
    }
  },
  {
    name: 'kb_rid_lookup',
    description: 'Look up what the Regen KB knows about an RID. Searches indexed documents via /query by RID string match. Optionally queries /entity/neighborhood for graph edges (best-effort, may return empty). Does NOT implement KOI-net dereference or /bundles/fetch - this is a KB convenience tool. Use parse_rid first to validate format.',
    inputSchema: {
      type: 'object',
      properties: {
        rid: {
          type: 'string',
          description: 'The RID to look up in the knowledge base'
        },
        include: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['documents', 'relationships', 'chunks']
          },
          default: ['documents'],
          description: 'What to include: "documents" = indexed doc records matching RID, "relationships" = graph edges referencing RID, "chunks" = text chunks'
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum items per category to return'
        }
      },
      required: ['rid']
    }
  },
  {
    name: 'kb_list_rids',
    description: 'List RIDs indexed in the Regen KB. Filter by context pattern, source, or date range. Returns aggregation counts. This is a KB discovery tool, NOT KOI-net /rids/fetch (which lists RIDs by type from a node).',
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'string',
          description: 'Filter by RID context pattern (e.g., "orn:regen.document", "https"). Partial match.'
        },
        source: {
          type: 'string',
          enum: ['notion', 'discourse', 'github', 'slack', 'telegram', 'twitter', 'substack', 'youtube', 'medium'],
          description: 'Filter by data source'
        },
        indexed_after: {
          type: 'string',
          format: 'date',
          description: 'Only RIDs indexed after this date (YYYY-MM-DD)'
        },
        indexed_before: {
          type: 'string',
          format: 'date',
          description: 'Only RIDs indexed before this date (YYYY-MM-DD)'
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          default: 50,
          description: 'Maximum RIDs to return'
        },
        offset: {
          type: 'number',
          minimum: 0,
          default: 0,
          description: 'Pagination offset'
        }
      }
    }
  },
  // =============================================================================
  // Feedback Tool (User Experience Feedback Collection)
  // =============================================================================
  {
    name: 'submit_feedback',
    description: `Submit feedback about your experience using KOI MCP tools.

Use this after completing a task to share:
- Whether it worked well or had issues
- Suggestions for improvement
- Bugs or unexpected behavior

Your feedback helps improve the system. All feedback is stored anonymously with session context.

Example usage:
  submit_feedback(rating=5, category="success", notes="Found exactly what I needed about basket tokens")
  submit_feedback(rating=2, category="bug", notes="search returned no results for 'Registry Agent'")`,
    inputSchema: {
      type: 'object',
      properties: {
        rating: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Rating from 1 (poor) to 5 (excellent)'
        },
        category: {
          type: 'string',
          enum: ['success', 'partial', 'bug', 'suggestion', 'question', 'other'],
          description: 'Type of feedback: success (worked great), partial (mostly worked), bug (something broke), suggestion (feature idea), question (need help), other'
        },
        task_description: {
          type: 'string',
          description: 'Brief description of what you were trying to do (optional but helpful)'
        },
        notes: {
          type: 'string',
          description: 'Detailed feedback, observations, or suggestions'
        },
        include_session_context: {
          type: 'boolean',
          description: 'Include recent tool calls for debugging context (default: true)',
          default: true
        }
      },
      required: ['rating', 'category', 'notes']
    }
  },

  // =============================================================================
  // VAULT TOOLS - Local Obsidian vault operations
  // =============================================================================
  {
    name: 'vault_read_note',
    description: `Read a note from your local Obsidian vault.

Returns the note content, parsed YAML frontmatter, extracted wikilinks, and entity type.

Example paths:
- "People/John Smith" - relative to vault root
- "Projects/My Project.md" - with extension
- "Daily Notes/2024-01-15"`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note, relative to vault root (e.g., "People/John Smith")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'vault_write_note',
    description: `Create or update a note in your local Obsidian vault.

Can write content with optional YAML frontmatter. If frontmatter is provided and the note
already has frontmatter, it will be merged/replaced.

Example:
  vault_write_note(
    path="People/Jane Doe",
    content="# Jane Doe\\n\\nWorks at [[Acme Corp]].",
    frontmatter={"@type": "schema:Person", "name": "Jane Doe", "affiliation": "Acme Corp"}
  )`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path for the note, relative to vault root'
        },
        content: {
          type: 'string',
          description: 'Note content (markdown)'
        },
        frontmatter: {
          type: 'object',
          description: 'Optional YAML frontmatter as JSON object',
          additionalProperties: true
        },
        backup: {
          type: 'boolean',
          description: 'Commit vault to git before making changes (default: true)',
          default: true
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'vault_list_notes',
    description: `List notes in your Obsidian vault, optionally filtered by folder or entity type.

Examples:
- List all people: vault_list_notes(entityType="Person")
- List notes in folder: vault_list_notes(folder="Projects")
- List recent meetings: vault_list_notes(folder="Meetings", limit=10)`,
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Folder to list (e.g., "People", "Meetings")'
        },
        entityType: {
          type: 'string',
          description: 'Filter by @type value (e.g., "Person", "Organization", "Meeting")'
        },
        limit: {
          type: 'number',
          description: 'Maximum notes to return (default: 100)',
          default: 100
        }
      }
    }
  },
  {
    name: 'vault_search_notes',
    description: `Search notes in your Obsidian vault by query string.

Searches note names, frontmatter, and optionally content.

Examples:
- Find person: vault_search_notes(query="John", entityType="Person")
- Search content: vault_search_notes(query="project timeline", searchContent=true)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        entityType: {
          type: 'string',
          description: 'Filter by @type value'
        },
        searchContent: {
          type: 'boolean',
          description: 'Search note content (default: true)',
          default: true
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
          default: 20
        }
      },
      required: ['query']
    }
  },
  {
    name: 'vault_get_entity',
    description: `Get a note by entity type and name. Searches common folder patterns.

This is a convenience tool for quickly finding entities like people or organizations.

Examples:
- vault_get_entity(entityType="Person", name="John Smith")
- vault_get_entity(entityType="Organization", name="Acme Corp")`,
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          description: 'Entity type (Person, Organization, Meeting, Project)'
        },
        name: {
          type: 'string',
          description: 'Entity name to search for'
        }
      },
      required: ['entityType', 'name']
    }
  },
  {
    name: 'vault_prep_meeting',
    description: `Prepare for a meeting by gathering context about attendees and related past meetings.

Given a list of attendees (people names), this tool:
1. Finds notes about each person
2. Searches for past meetings involving these people
3. Returns aggregated context to help prepare

Example:
  vault_prep_meeting(attendees=["John Smith", "Jane Doe"], project="Project X")`,
    inputSchema: {
      type: 'object',
      properties: {
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee names'
        },
        project: {
          type: 'string',
          description: 'Optional project name to filter by'
        },
        limit: {
          type: 'number',
          description: 'Max past meetings to include (default: 5)',
          default: 5
        }
      },
      required: ['attendees']
    }
  },
  // =============================================================================
  // ENTITY LINKING TOOLS - Extract and link entities in documents
  // =============================================================================
  {
    name: 'vault_extract_entities',
    description: `Extract entities from a document for linking with vault notes.

Returns structured extraction with:
- Entities found (people, organizations, locations, projects, concepts)
- Suggested wikilinks with offsets for insertion
- Suggested frontmatter additions
- Resolution status (existing note match vs new entity)

This is the first step in the entity linking workflow. Use the extraction
prompt returned by this tool with an LLM, then pass the response to
vault_process_extraction.

Example:
  vault_extract_entities(path="Articles/My Research.md")`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the document to process'
        },
        content: {
          type: 'string',
          description: 'Alternative: document content directly (instead of path)'
        },
        entityTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entity types to extract (default: all)',
          default: ['Person', 'Organization', 'Location', 'Project', 'Concept']
        }
      }
    }
  },
  {
    name: 'vault_process_extraction',
    description: `Process an LLM entity extraction response and resolve against vault.

Takes the extraction response from an LLM (generated using the prompt from
vault_extract_entities) and:
1. Parses the extracted entities
2. Resolves them against existing vault notes
3. Returns suggested wikilinks and frontmatter
4. Optionally applies changes to the document

Example workflow:
  1. extraction = vault_extract_entities(path="doc.md")
  2. Send extraction.prompt to LLM
  3. vault_process_extraction(path="doc.md", response=llm_response)`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the document being processed'
        },
        response: {
          type: 'string',
          description: 'The LLM extraction response (JSON with entities)'
        },
        preview: {
          type: 'boolean',
          description: 'Preview only, do not apply changes (default: true)',
          default: true
        },
        createEntities: {
          type: 'boolean',
          description: 'Create new entity files for unmatched entities (default: false)',
          default: false
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum confidence for wikilinks (default: 0.7)',
          default: 0.7
        }
      },
      required: ['path', 'response']
    }
  },
  {
    name: 'vault_find_backlinks',
    description: `Find all notes that link TO a given note via wikilinks.

This is the reverse of wikilinks - finds notes that reference the target.
Supports fuzzy matching for name variations.

Examples:
- vault_find_backlinks(name="Clare Attwell") - finds all notes with [[Clare Attwell]]
- vault_find_backlinks(name="Project X", fuzzy=true) - fuzzy match links`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the note to find backlinks for'
        },
        fuzzy: {
          type: 'boolean',
          description: 'Enable fuzzy matching (default: true)',
          default: true
        },
        threshold: {
          type: 'number',
          description: 'Fuzzy match threshold 0-1 (default: 0.85)',
          default: 0.85
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 50)',
          default: 50
        }
      },
      required: ['name']
    }
  },
  {
    name: 'vault_query_frontmatter',
    description: `Query notes by YAML frontmatter field values with fuzzy matching.

Supports array fields (like attendees) and normalizes wikilink formats.
"[[People/Clare Attwell]]" and "Clare Attwell" are treated as equivalent.

Examples:
- Find meetings with attendee: vault_query_frontmatter(field="attendees", value="Clare Attwell")
- Find notes by project: vault_query_frontmatter(field="project", value="VictoriaLandscapeGroup")
- Find by status: vault_query_frontmatter(field="status", value="completed")`,
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'Frontmatter field to query (e.g., "attendees", "project", "status")'
        },
        value: {
          type: 'string',
          description: 'Value to search for'
        },
        entityType: {
          type: 'string',
          description: 'Filter by @type value'
        },
        fuzzy: {
          type: 'boolean',
          description: 'Enable fuzzy matching (default: true)',
          default: true
        },
        threshold: {
          type: 'number',
          description: 'Fuzzy match threshold 0-1 (default: 0.8)',
          default: 0.8
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 50)',
          default: 50
        }
      },
      required: ['field', 'value']
    }
  },
  {
    name: 'vault_find_person',
    description: `Find all information about a person across the vault.

Combines multiple search strategies:
1. Person note lookup (with fuzzy matching)
2. Meetings where they're listed as attendee (YAML frontmatter)
3. Notes that link to them (backlinks/wikilinks)
4. Notes that mention them in content

This is the BEST tool for preparing for a meeting with someone.

Examples:
- vault_find_person(name="Clare Attwell")
- vault_find_person(name="Clare Atwell") - fuzzy matches "Clare Attwell"`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Person name to search for'
        },
        fuzzy: {
          type: 'boolean',
          description: 'Enable fuzzy matching (default: true)',
          default: true
        },
        threshold: {
          type: 'number',
          description: 'Fuzzy match threshold 0-1 (default: 0.8)',
          default: 0.8
        },
        limit: {
          type: 'number',
          description: 'Max results per category (default: 20)',
          default: 20
        }
      },
      required: ['name']
    }
  },
  // =============================================================================
  // BACKEND INTEGRATION TOOLS - Personal KOI backend entity storage
  // =============================================================================
  {
    name: 'vault_ingest_extraction',
    description: `Send Claude-extracted entities to the personal KOI backend for deduplication and storage.

This tool is the bridge between Claude Code entity extraction and the personal knowledge base.
It sends entities already extracted (in the current conversation) to the backend for:

1. **Deduplication** - Matches against existing entities in the KB using fuzzy matching
2. **Canonical URI assignment** - Creates stable URIs for new entities
3. **Storage** - Stores entities and document links in PostgreSQL
4. **Returns** - Resolved entities with URIs for vault linking

**Workflow:**
1. Use vault_extract_entities to get the extraction prompt
2. Extract entities in the conversation (no API cost)
3. Call vault_ingest_extraction with the extracted entities
4. Backend returns deduplicated entities with URIs
5. Use URIs to generate wikilinks

**Example:**
  vault_ingest_extraction(
    path="Articles/Salish Sea Herring.md",
    entities=[
      {name: "Jake Dingwall", type: "Person", mentions: ["Jake Dingwall"], confidence: 0.95},
      {name: "DFO", type: "Organization", mentions: ["DFO", "Fisheries and Oceans"], confidence: 0.9}
    ]
  )

**Note:** Requires the personal KOI backend to be running (port 8351).
If backend is unavailable, falls back to vault-only resolution.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the document being processed (used for document_rid)'
        },
        entities: {
          type: 'array',
          description: 'Extracted entities to ingest',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Entity name'
              },
              type: {
                type: 'string',
                description: 'Entity type: Person, Organization, Location, Project, Concept'
              },
              mentions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Text mentions found in the document'
              },
              confidence: {
                type: 'number',
                description: 'Extraction confidence (0-1)',
                default: 0.9
              },
              context: {
                type: 'string',
                description: 'Brief context about the entity from the document'
              },
              associated_people: {
                type: 'array',
                items: { type: 'string' },
                description: 'People mentioned alongside this entity (for per-entity context)'
              },
              associated_organizations: {
                type: 'array',
                items: { type: 'string' },
                description: 'Organizations mentioned alongside this entity (for per-entity context)'
              }
            },
            required: ['name', 'type']
          }
        },
        relationships: {
          type: 'array',
          description: 'Optional relationships between entities',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              predicate: { type: 'string' },
              object: { type: 'string' }
            },
            required: ['subject', 'predicate', 'object']
          }
        },
        fallbackToVault: {
          type: 'boolean',
          description: 'If backend unavailable, use vault-only resolution (default: true)',
          default: true
        },
        context: {
          type: 'object',
          description: 'Optional meeting context for better entity resolution (helps disambiguate names like "Sean" vs "Shawn Anderson")',
          properties: {
            project: {
              type: 'string',
              description: 'Project name (e.g., "Gaia AI") - enables multi-hop resolution via org→project relationships'
            },
            attendees: {
              type: 'array',
              items: { type: 'string' },
              description: 'Known attendees - finds other people they have met with'
            },
            organizations: {
              type: 'array',
              items: { type: 'string' },
              description: 'Organizations mentioned in the document - checks founder/member relationships'
            },
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'Topics/concepts discussed - finds people from meetings on similar topics'
            }
          }
        }
      },
      required: ['path', 'entities']
    }
  },
  // =============================================================================
  // VAULT ENTITY REGISTRATION TOOLS - Sync vault entities with KOI backend
  // =============================================================================
  {
    name: 'vault_register_entity',
    description: `Register a vault entity note (People, Organizations, etc.) with the KOI backend.

This tool registers an existing vault entity note with the backend for:
1. **Deduplication** - Checks if entity already exists in the knowledge base
2. **Canonical URI** - Assigns a stable URI that survives file renames
3. **RID Mapping** - Links the vault RID to the canonical entity
4. **Frontmatter Update** - Optionally adds koi: metadata to the note

**When to use:**
- After creating a new Person, Organization, or Project note
- To link vault entities with the backend knowledge base
- Before using /process-note to ensure entities are registered

**Example:**
  vault_register_entity(path="People/Clare Attwell.md")

**Returns:**
  {
    success: true,
    rid: "orn:obsidian.entity:Notes/Person/clare-attwell",
    canonical_uri: "orn:personal-koi.entity:person-clare-attwell-abc123",
    is_new: false,
    updated_frontmatter: true
  }

**Note:** Requires personal KOI backend running on port 8351.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the entity note (e.g., "People/Clare Attwell.md")'
        },
        update_frontmatter: {
          type: 'boolean',
          description: 'Update the note with koi: metadata (default: true)',
          default: true
        },
        backup: {
          type: 'boolean',
          description: 'Commit vault to git before making changes (default: true)',
          default: true
        }
      },
      required: ['path']
    }
  },
  {
    name: 'vault_sync_entities',
    description: `Bulk register all entity notes from specified folders with the KOI backend.

This tool scans entity folders (People, Organizations, Projects, etc.) and
registers all notes with the backend for deduplication and canonical URI assignment.

**Modes:**
- \`register_new\` - Only register entities not already in backend (default)
- \`full_sync\` - Re-register all entities, updating if changed
- \`sync_changed\` - Only sync entities with pending changes (most efficient for incremental updates)

**Example:**
  vault_sync_entities(folders=["People", "Organizations"])

**Returns:**
  {
    registered: 15,
    updated: 3,
    skipped: 42,
    errors: 0,
    by_type: { Person: 10, Organization: 8 }
  }

**Note:** Requires personal KOI backend running on port 8351.`,
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
          enum: ['register_new', 'full_sync', 'sync_changed'],
          description: 'Sync mode: register_new (only unregistered), full_sync (all entities), sync_changed (only entities with pending changes)',
          default: 'register_new'
        },
        update_frontmatter: {
          type: 'boolean',
          description: 'Update notes with koi: metadata (default: true)',
          default: true
        },
        backup: {
          type: 'boolean',
          description: 'Commit vault to git before making changes (default: true). Only applies when update_frontmatter is true.',
          default: true
        }
      }
    }
  },
  {
    name: 'vault_check_sync_status',
    description: `Check sync status between vault entities and the KOI backend.

Shows which vault entities are:
- \`linked\` - Synced with backend, content unchanged
- \`local_only\` - Exists in vault but not registered in backend
- \`pending_sync\` - Registered but content has changed
- \`conflict\` - Local and backend have diverged

**Example:**
  vault_check_sync_status(folder="People")

**Returns:**
  {
    total: 50,
    linked: 42,
    local_only: 5,
    pending_sync: 3,
    conflict: 0,
    entities: [
      { path: "People/Clare Attwell.md", status: "linked", canonical_uri: "..." },
      { path: "People/New Person.md", status: "local_only" }
    ]
  }`,
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Folder to check (e.g., "People"). If omitted, checks all entity folders.'
        }
      }
    }
  },
  // =============================================================================
  // ENTITY SCHEMA TOOLS - Dynamic entity type configuration
  // =============================================================================
  {
    name: 'list_entity_types',
    description: `List available entity types and their resolution configuration.

This tool returns the dynamically loaded entity type schemas from the backend.
Use this to discover available entity types instead of hardcoding type names.

**Returns:**
- Type key (e.g., "Person", "Organization", "Project")
- Vault folder mapping (e.g., "People", "Organizations", "Projects")
- Phonetic matching enabled (for transcription typo handling)
- Resolution thresholds (min_context_people, similarity_threshold)

**When to use:**
- Before entity extraction to know available types
- To check if phonetic matching is enabled for a type
- To understand entity type configuration

**Example response:**
| Type | Folder | Phonetic | Min Context | Similarity |
|------|--------|----------|-------------|------------|
| Person | People | ✓ | 1 | 0.92 |
| Organization | Organizations | ✓ | 2 | 0.85 |
| Project | Projects | ✓ | 2 | 0.85 |`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // =============================================================================
  // SESSION SEARCH TOOLS - Search Claude Code conversation history
  // =============================================================================
  {
    name: 'search_sessions',
    description: `Search your Claude Code session history.

Performs semantic search over indexed Claude Code conversation transcripts.
Use this to find past discussions, solutions, or context from previous sessions.

**Features:**
- Semantic search (when embeddings available) or text search (fallback)
- Returns matching conversation chunks with session context
- Includes session metadata (summary, first prompt, date)

**Use cases:**
- "What did we discuss about entity resolution?"
- "Find sessions where I worked on the KOI processor"
- "When did I last debug the pgvector setup?"

**Example:**
  search_sessions(query="entity resolution pgvector", limit=5)

**Returns:**
  {
    results: [
      {
        session_id: "abc123",
        chunk_text: "User: How do I set up entity resolution?\\n\\nAssistant: ...",
        similarity: 0.85,
        summary: "KOI entity resolution setup",
        timestamp: "2026-01-15T10:30:00"
      }
    ],
    count: 5,
    search_type: "semantic"
  }

**Note:** Requires session sensor to have indexed sessions first.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "pgvector setup", "entity deduplication")'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 50
        },
        session_id: {
          type: 'string',
          description: 'Optional: filter to a specific session ID'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_session_stats',
    description: `Get statistics about indexed Claude Code sessions.

Shows how many sessions have been indexed and their metadata.

**Returns:**
- Total sessions indexed
- Total conversation chunks
- Embedding coverage percentage
- Recent sessions list

**Example:**
  get_session_stats()`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'search_sessions_by_tool',
    description: `Find sessions by tool or MCP server usage.

Search for sessions where specific tools were used.

**Use cases:**
- "Sessions where I used the Regen ledger MCP"
- "Sessions with heavy Bash usage"
- "Which sessions used the commit skill"

**Example:**
  search_sessions_by_tool(tool="Bash")
  search_sessions_by_tool(mcp_server="personal-koi")

**Without filters:** Returns overall tool usage statistics across all sessions.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Tool name to search for (e.g., "Bash", "Read", "Edit")'
        },
        mcp_server: {
          type: 'string',
          description: 'MCP server name to filter by (e.g., "personal-koi", "regen-ledger")'
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
          default: 20
        }
      }
    }
  },
  {
    name: 'search_sessions_by_files',
    description: `Find sessions by files accessed.

Search for sessions that read/edited/wrote specific files.

**Use cases:**
- "Sessions that edited koi-processor files"
- "Sessions working on the MCP server"
- "When did I last work on the sensor?"

**Example:**
  search_sessions_by_files(path_contains="koi-processor")
  search_sessions_by_files(path_contains="claude_session_sensor")

**Without filters:** Returns sessions with most files accessed.`,
    inputSchema: {
      type: 'object',
      properties: {
        path_contains: {
          type: 'string',
          description: 'File path substring to search for (e.g., "koi-processor", "sensor")'
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
          default: 20
        }
      }
    }
  }
];
