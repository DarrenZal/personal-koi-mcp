/**
 * Entity Resolution Module
 *
 * Multi-tier resolution for matching extracted entities to vault notes.
 * Supports exact match, fuzzy match, and new entity creation suggestions.
 */

import { VaultEntity } from './entity-extraction.js';

export interface ResolutionResult {
  entity: string;
  type: string;
  matchType: 'exact' | 'alias' | 'fuzzy' | 'new';
  confidence: number;
  matchedTo: string | null;  // Path to existing note, or null for new
  suggestions?: Array<{
    path: string;
    confidence: number;
    matchType: 'exact' | 'alias' | 'fuzzy';
  }>;
}

export interface ResolverConfig {
  // Fuzzy matching thresholds by entity type
  thresholds: {
    Person: number;
    Organization: number;
    Location: number;
    Project: number;
    Concept: number;
  };
  // Whether to suggest creating new entities
  allowNewEntities: boolean;
  // Minimum confidence to consider a match
  minConfidence: number;
}

const DEFAULT_CONFIG: ResolverConfig = {
  thresholds: {
    Person: 0.90,
    Organization: 0.85,
    Location: 0.80,
    Project: 0.80,
    Concept: 0.75
  },
  allowNewEntities: true,
  minConfidence: 0.6
};

/**
 * Jaro similarity between two strings
 */
function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    matches / s1.length +
    matches / s2.length +
    (matches - transpositions / 2) / matches
  ) / 3;
}

/**
 * Jaro-Winkler similarity (gives more weight to common prefixes)
 */
export function jaroWinklerSimilarity(s1: string, s2: string, prefixScale = 0.1): number {
  const jaroSim = jaroSimilarity(s1, s2);

  // Find common prefix length (up to 4 characters)
  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  return jaroSim + prefixLength * prefixScale * (1 - jaroSim);
}

/**
 * Normalize a string for comparison
 */
export function normalizeForComparison(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s'-]/g, '');
}

/**
 * Build a lookup index from vault entities
 */
export function buildEntityLookup(entities: VaultEntity[]): {
  byNormalizedName: Map<string, VaultEntity>;
  byAlias: Map<string, VaultEntity>;
  byType: Map<string, VaultEntity[]>;
  all: VaultEntity[];
} {
  const byNormalizedName = new Map<string, VaultEntity>();
  const byAlias = new Map<string, VaultEntity>();
  const byType = new Map<string, VaultEntity[]>();

  for (const entity of entities) {
    // Index by normalized name
    const normalizedName = normalizeForComparison(entity.name);
    byNormalizedName.set(normalizedName, entity);

    // Index by aliases
    for (const alias of entity.aliases) {
      const normalizedAlias = normalizeForComparison(alias);
      byAlias.set(normalizedAlias, entity);
    }

    // Index by type
    const typeList = byType.get(entity.type) || [];
    typeList.push(entity);
    byType.set(entity.type, typeList);
  }

  return { byNormalizedName, byAlias, byType, all: entities };
}

/**
 * Multi-tier entity resolution
 */
export class EntityResolver {
  private config: ResolverConfig;
  private lookup: ReturnType<typeof buildEntityLookup> | null = null;

  constructor(config: Partial<ResolverConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load vault entities for resolution
   */
  loadEntities(entities: VaultEntity[]): void {
    this.lookup = buildEntityLookup(entities);
  }

  /**
   * Resolve a single entity
   */
  resolve(
    entityName: string,
    entityType: string
  ): ResolutionResult {
    if (!this.lookup) {
      throw new Error('Resolver not initialized. Call loadEntities() first.');
    }

    const normalizedName = normalizeForComparison(entityName);
    const suggestions: ResolutionResult['suggestions'] = [];

    // Tier 1: Exact name match
    const exactMatch = this.lookup.byNormalizedName.get(normalizedName);
    if (exactMatch) {
      return {
        entity: entityName,
        type: entityType,
        matchType: 'exact',
        confidence: 1.0,
        matchedTo: exactMatch.path
      };
    }

    // Tier 2: Alias match
    const aliasMatch = this.lookup.byAlias.get(normalizedName);
    if (aliasMatch) {
      return {
        entity: entityName,
        type: entityType,
        matchType: 'alias',
        confidence: 0.95,
        matchedTo: aliasMatch.path
      };
    }

    // Tier 3: Fuzzy match
    const threshold = this.config.thresholds[entityType as keyof typeof this.config.thresholds]
      || this.config.minConfidence;

    // Search same type first, then all
    const sameTypeEntities = this.lookup.byType.get(entityType) || [];
    const entitiesToSearch = sameTypeEntities.length > 0
      ? sameTypeEntities
      : this.lookup.all;

    let bestMatch: { entity: VaultEntity; score: number } | null = null;

    for (const candidate of entitiesToSearch) {
      // Compare with name
      const nameScore = jaroWinklerSimilarity(
        normalizedName,
        normalizeForComparison(candidate.name)
      );

      if (nameScore >= threshold && (!bestMatch || nameScore > bestMatch.score)) {
        bestMatch = { entity: candidate, score: nameScore };
      }

      // Compare with aliases
      for (const alias of candidate.aliases) {
        const aliasScore = jaroWinklerSimilarity(
          normalizedName,
          normalizeForComparison(alias)
        );
        if (aliasScore >= threshold && (!bestMatch || aliasScore > bestMatch.score)) {
          bestMatch = { entity: candidate, score: aliasScore };
        }
      }

      // Collect suggestions above min confidence
      const maxScore = Math.max(
        nameScore,
        ...candidate.aliases.map(a =>
          jaroWinklerSimilarity(normalizedName, normalizeForComparison(a))
        )
      );

      if (maxScore >= this.config.minConfidence) {
        suggestions.push({
          path: candidate.path,
          confidence: maxScore,
          matchType: maxScore >= threshold ? 'fuzzy' : 'fuzzy'
        });
      }
    }

    // Sort suggestions by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence);

    if (bestMatch && bestMatch.score >= threshold) {
      return {
        entity: entityName,
        type: entityType,
        matchType: 'fuzzy',
        confidence: bestMatch.score,
        matchedTo: bestMatch.entity.path,
        suggestions: suggestions.slice(0, 5)
      };
    }

    // No match found - suggest creating new
    return {
      entity: entityName,
      type: entityType,
      matchType: 'new',
      confidence: 0,
      matchedTo: null,
      suggestions: suggestions.slice(0, 5)
    };
  }

  /**
   * Resolve multiple entities
   */
  resolveAll(
    entities: Array<{ name: string; type: string }>
  ): Map<string, ResolutionResult> {
    const results = new Map<string, ResolutionResult>();

    for (const entity of entities) {
      const result = this.resolve(entity.name, entity.type);
      results.set(entity.name, result);
    }

    return results;
  }

  /**
   * Get suggested path for a new entity
   */
  getSuggestedPath(entityName: string, entityType: string): string {
    const folder = entityType === 'Person' ? 'People' :
                   entityType === 'Organization' ? 'Organizations' :
                   entityType === 'Location' ? 'Locations' :
                   entityType === 'Project' ? 'Projects' :
                   'Concepts';

    // Sanitize entity name for file path
    const safeName = entityName
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return `${folder}/${safeName}`;
  }
}

/**
 * Create a default resolver instance
 */
export function createResolver(config?: Partial<ResolverConfig>): EntityResolver {
  return new EntityResolver(config);
}
