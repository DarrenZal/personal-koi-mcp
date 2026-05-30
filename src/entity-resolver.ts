/**
 * Entity Resolution Module
 *
 * Multi-tier resolution for matching extracted entities to vault notes.
 * Supports exact match, fuzzy match, and new entity creation suggestions.
 */

import { VaultEntity } from './entity-extraction.js';
import { typeToFolderSync } from './entity-schema.js';

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
 * Words that frequently appear in entity names but carry little
 * disambiguation value. A fuzzy match whose ONLY overlap is one of these
 * words has not actually matched; it has matched on shared boilerplate.
 *
 * Two layers:
 *   - Generic: articles, prepositions, conjunctions, structural suffixes
 *     ("foundation", "institute", "labs", etc.).
 *   - Domain prefixes: cluster-specific words that dominate the local
 *     namespace ("regen" appears in many distinct Regen Network projects;
 *     "claims" appears in many distinct claims-related concepts). These
 *     are added because they're frequent enough in this vault to act as
 *     common words even though they're domain-meaningful.
 */
const COMMON_WORDS = new Set<string>([
  // articles, prepositions, conjunctions
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'in', 'at', 'by', 'to', 'with', 'on',
  // structural suffixes
  'network', 'foundation', 'institute', 'project', 'projects', 'group', 'lab',
  'labs', 'capital', 'system', 'systems', 'hub', 'centre', 'center',
  'international', 'org', 'inc', 'llc', 'corp', 'company', 'co',
  'platform', 'service', 'services', 'protocol', 'app',
  // domain prefixes (vault-cluster-specific; tune as patterns emerge)
  'regen', 'koi', 'gaia', 'spore',
]);

/**
 * Compute the set of "distinctive words" in a name — tokens after lowercase,
 * with COMMON_WORDS filtered out. Used as the secondary check after token-set
 * overlap, to catch matches where the only shared tokens are common words.
 */
function distinctiveWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((tok) => tok.length > 0 && !COMMON_WORDS.has(tok)),
  );
}

/**
 * Strict overlap check for fuzzy matches.
 *
 * Returns false (rejecting the match) if any of the following holds:
 *   - Length-ratio: the longer string is >1.8× the shorter AND JW < 0.95
 *     (catches prefix-match inflation like "regen ai" vs "regen ai bd sprint scope").
 *   - Multi-word collapse: BOTH names have ≥2 tokens AND they share zero
 *     plain tokens (catches "Silke Helfrich" → "Simon Grant").
 *   - Domain-prefix collapse: BOTH names have ≥2 tokens AND their distinctive
 *     words (after COMMON_WORDS filter) share zero overlap (catches
 *     "Common Crawl Foundation" → "Cosmo Local Foundation": only "foundation"
 *     overlaps; once filtered, distinctive sets {common, crawl} and
 *     {cosmo, local} are disjoint. Same pattern as "Regen Compass" →
 *     "Regen AI Builders": only "regen" overlaps; distinctive sets
 *     {compass} and {ai, builders} are disjoint).
 *
 * Single-word inputs (or single-word candidates) are not subject to the
 * multi-word checks, but their JW threshold is enforced upstream by the
 * caller.
 */
export function passesFuzzyOverlapCheck(
  inputName: string,
  candidateName: string,
  jwScore: number,
): { ok: true } | { ok: false; reason: string } {
  const a = inputName.toLowerCase().trim();
  const b = candidateName.toLowerCase().trim();

  // Length-ratio guard
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter > 0 && longer / shorter > 1.8 && jwScore < 0.95) {
    return {
      ok: false,
      reason: `length ratio ${(longer / shorter).toFixed(1)}× with JW ${jwScore.toFixed(3)} < 0.95`,
    };
  }

  const tokensA = a.split(/\s+/).filter((t) => t.length > 0);
  const tokensB = b.split(/\s+/).filter((t) => t.length > 0);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  // Single-token strict-JW guard. When EITHER side is one token (e.g. "RegenOS",
  // "Microsoft", "Marie"), JW dominates because there's no token-set structure
  // to check. Without a strict bar, "Regen Compass" (2 tokens) merges into
  // "RegenOS" (1 token) at JW=0.92 because the resolver's threshold is 0.85.
  // Backend resolver does the same thing (see api/personal_ingest_api.py
  // passes_token_overlap_check single-word branch). Single-word matches
  // require JW ≥ 0.95 — and the multi-word distinctive-word check below
  // is skipped (it requires ≥2 tokens on both sides).
  if (tokensA.length === 1 || tokensB.length === 1) {
    if (jwScore < 0.95) {
      return {
        ok: false,
        reason: `single-token side requires JW ≥ 0.95, got ${jwScore.toFixed(3)}`,
      };
    }
    return { ok: true };
  }

  // Multi-word checks: both sides have ≥2 tokens
  if (tokensA.length >= 2 && tokensB.length >= 2) {
    // 2-token full-name surname guard (mirrors backend passes_token_overlap_check
    // in api/personal_ingest_api.py): for two "First Last" names, a shared first
    // name must NOT inflate the match — require the family names (last tokens) to
    // be JW-similar, so "Benjamin Life" ≠ "Benjamin Neal" (the originating false
    // merge from session 4957a381). Threshold matches the backend's 0.75.
    if (tokensA.length === 2 && tokensB.length === 2) {
      const lastJw = jaroWinklerSimilarity(tokensA[1], tokensB[1]);
      if (lastJw < 0.75) {
        return {
          ok: false,
          reason: `2-token names with dissimilar surnames (JW ${lastJw.toFixed(3)} < 0.75): "${tokensA[1]}" vs "${tokensB[1]}"`,
        };
      }
    }

    const plainOverlap = [...setA].filter((t) => setB.has(t));
    if (plainOverlap.length === 0) {
      return {
        ok: false,
        reason: `zero token overlap between multi-word names`,
      };
    }

    const distA = distinctiveWords(a);
    const distB = distinctiveWords(b);
    if (distA.size === 0 || distB.size === 0) {
      // Either side has no distinctive words after filtering. Two cases:
      //   - Both empty: the names are entirely common words (e.g.
      //     "Regen Network" vs "Regen Foundation" — both filter to {}).
      //     Genuine same-entity would have hit Tier 1 exact match, so a fuzzy
      //     hit between two all-common-words names is suspect. Reject.
      //   - Asymmetric (one empty, one not): the all-common-words side is
      //     too generic to safely claim a distinctive-content candidate
      //     (e.g. "Regen OS" {os} vs "Regen KOI" {}). Reject.
      return {
        ok: false,
        reason:
          distA.size === 0 && distB.size === 0
            ? `both names entirely COMMON_WORDS (only shared tokens: ${plainOverlap.join(',')})`
            : `asymmetric distinctive content (one side filters to all COMMON_WORDS, other has distinctive tokens) — too generic to merge`,
      };
    }
    const distOverlap = [...distA].filter((t) => distB.has(t));
    if (distOverlap.length === 0) {
      return {
        ok: false,
        reason: `distinctive-word overlap = 0 (only COMMON_WORDS shared: ${plainOverlap.join(',')})`,
      };
    }
  }

  return { ok: true };
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
      const candidateNormalized = normalizeForComparison(candidate.name);

      // Compare with name
      const nameScore = jaroWinklerSimilarity(normalizedName, candidateNormalized);

      if (nameScore >= threshold && (!bestMatch || nameScore > bestMatch.score)) {
        // Distinctive-word + length-ratio guard. Without this, "Common Crawl
        // Foundation" merges into "Cosmo Local Foundation" at JW=0.88 because
        // the shared "foundation" suffix dominates. Same failure shape collapses
        // "Regen Compass" into "Regen AI Builders". The guard rejects matches
        // whose only token overlap is COMMON_WORDS.
        const guard = passesFuzzyOverlapCheck(
          normalizedName,
          candidateNormalized,
          nameScore,
        );
        if (guard.ok) {
          bestMatch = { entity: candidate, score: nameScore };
        }
        // Failed-guard candidates are silently skipped from bestMatch but may
        // still appear in `suggestions` below for operator inspection.
      }

      // Compare with aliases — apply the SAME guard as for names.
      //
      // Earlier this branch was exempted on the theory that aliases are
      // human-vouched. That was wrong: exact alias match is human-vouched
      // (Tier 2 above, byAlias.get exact lookup), but FUZZY alias match
      // is just JW-similarity against an alias string and can false-merge
      // exactly the same way as fuzzy name match. Real failure that
      // motivated this fix: "Regen Compass" → "Projects/RegenOS" at
      // JW=0.923 because RegenOS has alias "Regen OS" and JW("regen
      // compass","regen os") ≈ 0.92. The guard rejects this (distinctive
      // overlap = 0; only "regen" shared, which is COMMON_WORDS).
      for (const alias of candidate.aliases) {
        const aliasNormalized = normalizeForComparison(alias);
        const aliasScore = jaroWinklerSimilarity(normalizedName, aliasNormalized);
        if (aliasScore >= threshold && (!bestMatch || aliasScore > bestMatch.score)) {
          const guard = passesFuzzyOverlapCheck(
            normalizedName,
            aliasNormalized,
            aliasScore,
          );
          if (guard.ok) {
            bestMatch = { entity: candidate, score: aliasScore };
          }
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
    // Use schema-driven folder mapping
    const folder = typeToFolderSync(entityType);

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
