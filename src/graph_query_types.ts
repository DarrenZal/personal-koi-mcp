export const GRAPH_QUERY_TYPES = [
  // Core entity queries
  'list_repos',
  'find_by_type',
  'search_entities',
  'related_entities',
  'list_entity_types',
  'get_entity_stats',

  // Message/Keeper relationship queries
  'keeper_for_msg',
  'msgs_for_keeper',

  // Call graph queries (11,331 CALLS edges available)
  'find_callers',
  'find_callees',
  'find_call_graph',

  // Module queries
  'list_modules',
  'get_module',
  'search_modules',
  'module_entities',
  'module_for_entity',

  // Code-graph analysis queries (Leiden communities, flows, impact, staleness)
  'code_impact',
  'check_staleness',
  'list_communities',
  'community_members',
  'community_for_entity',
  'list_flows',
  'flow_steps',
  'flows_for_entity',

  // Concept queries (available but may return empty results)
  'list_concepts',
  'explain_concept',
  'find_concept_for_query',
] as const;

export type GraphQueryType = (typeof GRAPH_QUERY_TYPES)[number];

