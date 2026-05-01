/**
 * Recall router — Strand A4 hybrid heuristic + operator-override.
 *
 * Per Tier-2 plan §Step 4 (ratified Strand A = A4):
 * - If `hint` provided and valid, return it (operator-override; A1 leg).
 * - Else apply A2 heuristic over query text:
 *   - Temporal: dates, "when/before/after/since/until/recent/latest/first/last/2026" or ISO date.
 *   - Relationship: "what … (dispatch|cite|reference|supersede|relate|invoke|trigger|coordinate|orchestrate)"
 *                   OR multi-hop cues (walk|trace|chain|how … from … to).
 *   - Default: semantic.
 *
 * Step 4 scope: classification only. Dispatch wiring lands in Step 6.
 */

export type RecallShape = "semantic" | "temporal" | "relationship";

export type ShapeSource = "auto" | "hint" | "fallback";

export interface ShapeResolution {
  shape: RecallShape;
  source: ShapeSource;
}

const VALID_HINTS: ReadonlySet<string> = new Set([
  "auto",
  "semantic",
  "temporal",
  "relationship",
]);

// --- Temporal cues ---
// Keyword cue: when/before/after/since/until/valid/expired/recent/latest/first/last
// Year cue:    2026 (current canon-year; expand list if cross-year queries surface)
// ISO-date cue: \d{4}-\d{2}-\d{2}
const TEMPORAL_KEYWORD_RE =
  /\b(when|date|time|before|after|since|until|valid|expired|recent|latest|first|last|2026)\b/i;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

// --- Relationship cues ---
// Verb cue:        what … (dispatch|cite|reference|supersede|relate|invoke|trigger|coordinate|orchestrate)
// Multi-hop cue:   walk/trace/chain  OR  how … from … to
const RELATIONSHIP_VERB_RE =
  /\bwhat[^.?!]*(dispatch|cite|reference|supersede|relate|invoke|trigger|coordinate|orchestrate)/i;
const MULTIHOP_CUE_RE = /\b(walk|trace|chain)\b/i;
const HOW_FROM_TO_RE = /\bhow\b[^.?!]*\bfrom\b[^.?!]*\bto\b/i;

// --- Auxiliary-verb + state-change cue (temporal) ---
// Captures shapes like "Has X been superseded?", "Is Y deprecated?", "Are Zs expired?"
// — questions about validity-state-over-time. These read temporally because
// the answer requires checking valid_at/expired_at on RELATES_TO edges.
// Must fire BEFORE relationship-verb regex so "supersede"/"superseded" in
// state-change form routes to temporal (Graphiti's valid_at machinery), not
// relationship (which expects "what … supersede" graph-shaped queries).
const AUX_STATE_CHANGE_RE =
  /\b(has|is|was|were|are)\b.*\b(superseded|deprecated|expired|valid|invalidated|retired|active)\b/i;

/**
 * Resolve query shape per A4 hybrid policy.
 *
 * @param query   Natural-language query text.
 * @param hint    Optional operator-supplied shape hint
 *                ("auto" | "semantic" | "temporal" | "relationship"). When
 *                "auto" or absent, falls through to heuristic. Invalid hints
 *                are ignored (treated as absent).
 * @returns       `{ shape, source }`. `source = "hint"` when an explicit
 *                non-auto hint is honored; otherwise `"auto"`.
 */
export function resolveShape(query: string, hint?: string): ShapeResolution {
  // A1 leg: explicit operator override (only when hint is a non-auto known value).
  if (hint && VALID_HINTS.has(hint) && hint !== "auto") {
    return { shape: hint as RecallShape, source: "hint" };
  }

  // A2 leg: heuristic over query text.
  //
  // Order:
  //   1. Aux-verb + state-change → temporal (must fire BEFORE relationship-verb
  //      regex; "supersede" appears in both regexes but state-change form is
  //      validity-state-shaped, not graph-shaped, and routes to Graphiti's
  //      valid_at machinery rather than chain-walking).
  //   2. Relationship cues (what … verb, walk/trace/chain, how … from … to).
  //      Stronger than plain temporal keywords when both fire; most relationship
  //      queries reference time implicitly.
  //   3. Plain temporal keyword/ISO-date cues.
  //   4. Default semantic.
  if (AUX_STATE_CHANGE_RE.test(query)) {
    return { shape: "temporal", source: "auto" };
  }

  if (
    RELATIONSHIP_VERB_RE.test(query) ||
    MULTIHOP_CUE_RE.test(query) ||
    HOW_FROM_TO_RE.test(query)
  ) {
    return { shape: "relationship", source: "auto" };
  }

  if (TEMPORAL_KEYWORD_RE.test(query) || ISO_DATE_RE.test(query)) {
    return { shape: "temporal", source: "auto" };
  }

  return { shape: "semantic", source: "auto" };
}

/**
 * Stub for the recall tool's leg dispatcher. Step 6 fills in the actual
 * KOI / Graphiti client calls. This stub establishes the call sites + the
 * type contract so Step 4 can land independently.
 */
export interface DispatchInput {
  query: string;
  shape: RecallShape;
  limit: number;
}

export interface DispatchResult {
  results: unknown[];
  legs_queried: string[];
  latency_ms: { total: number; hybrid: number | null; walk: number | null };
}

export async function dispatchToLeg(input: DispatchInput): Promise<DispatchResult> {
  // Stub kept for Step 4 type contract; real implementation lives in
  // src/tools/recall.ts (Tier-3, Wave 1 close-out 2026-04-30: hybrid +
  // walk legs against PostgreSQL substrate).
  void input;
  throw new Error(
    "recall dispatch stub — see src/tools/recall.ts for the wired implementation",
  );
}
