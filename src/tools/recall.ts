/**
 * Recall MCP tool — Tier-2 Step 6 (Strand C2).
 *
 * Routes a query by shape:
 *   - "semantic"     → KOI hybrid retrieval (`/knowledge/unified-search`)
 *   - "temporal"     → Graphiti hybrid edge search (FalkorDB sidecar at koi_canon_v1)
 *   - "relationship" → Graphiti hybrid edge search (same backend; surface stays
 *                      uniform; sub-routing reserved for Tier-3)
 *
 * Shape source priority (per Step 4 Strand A4):
 *   1. Operator hint via `shape` arg (when not "auto").
 *   2. Heuristic from `resolveShape()` over query text.
 *   3. Defaults to "semantic".
 *
 * Failure semantics (per plan §Strand C "MCP contract"):
 *   - Graphiti unreachable → fall through to KOI hybrid; `shape_source = "fallback"`.
 *   - KOI unreachable      → return `error_code: "substrate_unavailable"`.
 *   - Both unreachable     → same `substrate_unavailable` error.
 *
 * Revert mechanism (per plan §Rollback): env `RECALL_ROUTING_ENABLED=false`
 * routes ALL queries to KOI hybrid regardless of shape; Graphiti leg disabled.
 *
 * Per-call observability: every invocation appends a JSON-line to
 * `~/.koi/logs/recall-metrics.jsonl` (per plan §Rollback "Metrics computation").
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import axios from "axios";
import {
  resolveShape,
  RecallShape,
  ShapeSource,
} from "../recall/router.js";

// --- Config ---
const KOI_BASE_URL =
  process.env.KOI_API_ENDPOINT || "http://127.0.0.1:8351";
const GRAPHITI_GROUP_ID =
  process.env.GRAPHITI_GROUP_ID || "koi_canon_v1";
const GRAPHITI_PYTHON =
  process.env.GRAPHITI_PYTHON ||
  path.join(os.homedir(), ".venv/graphiti-poc/bin/python3");
const GRAPHITI_SIDECAR_PATH = path.join(
  process.cwd(),
  "python",
  "graphiti_recall.py",
);
// Fallback: resolve relative to this module if cwd-rooted path doesn't exist.
const GRAPHITI_SIDECAR_FALLBACK = path.join(
  // src/tools/recall.ts → ../../python/graphiti_recall.py at runtime, but with
  // tsx/ESM resolution we can't use __dirname; use a candidate list.
  os.homedir(),
  "projects/personal-koi-mcp/python/graphiti_recall.py",
);
const METRICS_DIR = path.join(os.homedir(), ".koi", "logs");
const METRICS_PATH = path.join(METRICS_DIR, "recall-metrics.jsonl");
const GRAPHITI_TIMEOUT_MS = 30_000;

// --- Types per plan §Strand C "MCP contract" ---
export interface RecallInput {
  query: string;
  shape?: "auto" | "semantic" | "temporal" | "relationship";
  limit?: number;
  include_legs?: boolean;
}

export interface RecallResultItem {
  id: string;
  score: number;
  leg: "koi" | "graphiti";
  content: string;
  metadata: Record<string, unknown>;
}

export interface RecallRouting {
  shape_resolved: RecallShape;
  shape_source: ShapeSource;
  legs_queried: Array<"koi" | "graphiti">;
}

export interface RecallLatency {
  total: number;
  koi: number | null;
  graphiti: number | null;
}

export interface RecallResponse {
  results: RecallResultItem[];
  routing: RecallRouting;
  latency_ms: RecallLatency;
  error_code?: "substrate_unavailable";
  error?: string;
  legs?: Record<string, unknown>; // populated when include_legs=true
}

// --- KOI client (axios; mirrors koi-api-tools.ts:28-30) ---
let _koiClient: ReturnType<typeof axios.create> | null = null;
function koiClient(): ReturnType<typeof axios.create> {
  if (!_koiClient) {
    _koiClient = axios.create({
      baseURL: KOI_BASE_URL,
      timeout: 30_000,
    });
  }
  return _koiClient;
}

// --- KOI leg ---
async function queryKoi(
  query: string,
  limit: number,
): Promise<{
  results: RecallResultItem[];
  raw: Record<string, unknown>;
  latency_ms: number;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const { data } = await koiClient().get("/knowledge/unified-search", {
      params: { query, limit, include: "entities,facts,sessions,wiki,vault" },
    });
    const items: RecallResultItem[] = [];
    const raw = data as Record<string, unknown>;
    const rawResults = (raw.results as Array<Record<string, unknown>>) || [];
    for (const r of rawResults.slice(0, limit)) {
      const sourceRaw = (r.source as string) || "";
      const text = (r.text as string) || "";
      const sid = r.session_id as string | undefined;
      const id = sid || (r.uri as string) || (r.path as string) || text.slice(0, 64);
      items.push({
        id: String(id),
        score: typeof r.score === "number" ? (r.score as number) : 0,
        leg: "koi",
        content: text,
        metadata: {
          source: sourceRaw,
          session_id: sid,
          uri: r.uri,
          path: r.path,
          ...(r.metadata as Record<string, unknown> | undefined),
        },
      });
    }
    return {
      results: items,
      raw,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      results: [],
      raw: {},
      latency_ms: Date.now() - t0,
      error: msg,
    };
  }
}

// --- Graphiti leg ---
function resolveGraphitiSidecar(): string {
  if (fs.existsSync(GRAPHITI_SIDECAR_PATH)) return GRAPHITI_SIDECAR_PATH;
  return GRAPHITI_SIDECAR_FALLBACK;
}

async function queryGraphiti(
  query: string,
  limit: number,
): Promise<{
  results: RecallResultItem[];
  raw: Record<string, unknown>;
  latency_ms: number;
  error?: string;
}> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const sidecarPath = resolveGraphitiSidecar();
    const args = [
      sidecarPath,
      "--query",
      query,
      "--limit",
      String(limit),
      "--group-id",
      GRAPHITI_GROUP_ID,
    ];
    const proc = spawn(GRAPHITI_PYTHON, args, {
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (out: {
      results: RecallResultItem[];
      raw: Record<string, unknown>;
      latency_ms: number;
      error?: string;
    }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(out);
      }
    };
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err: Error) => {
      done({
        results: [],
        raw: {},
        latency_ms: Date.now() - t0,
        error: `graphiti spawn error: ${err.message}`,
      });
    });
    proc.on("close", (code: number | null) => {
      const lat = Date.now() - t0;
      if (code !== 0 && !stdout) {
        done({
          results: [],
          raw: {},
          latency_ms: lat,
          error: `graphiti exited ${code}: ${stderr.slice(0, 300)}`,
        });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        done({
          results: [],
          raw: {},
          latency_ms: lat,
          error: `graphiti stdout parse error: ${(e as Error).message}`,
        });
        return;
      }
      if (!parsed || parsed.ok !== true) {
        done({
          results: [],
          raw: parsed || {},
          latency_ms: lat,
          error: `graphiti not ok: ${parsed?.error || "unknown"}`,
        });
        return;
      }
      // Map Graphiti session_ids + edges to RecallResultItem[].
      // Edges carry the structural payload; session_ids surface separately
      // so callers can score against ground-truth UUIDs (matches POC bench
      // expectation).
      const items: RecallResultItem[] = [];
      const sessionIds = (parsed.session_ids as string[]) || [];
      const edges = (parsed.edges as Array<Record<string, unknown>>) || [];
      // Emit one item per session_id (rank-stable; first edge that surfaced it).
      for (const sid of sessionIds) {
        items.push({
          id: sid,
          score: 1.0, // Graphiti's hybrid edge search is rank-ordered; uniform 1.0
          leg: "graphiti",
          content: `claude-code session ${sid}`,
          metadata: {
            session_id: sid,
            source: "graphiti_session_entity",
          },
        });
        if (items.length >= limit) break;
      }
      // If no session UUIDs surfaced, emit edges as items so caller still
      // sees something (e.g., a relationship query that surfaces facts but
      // no session attribution).
      if (items.length === 0) {
        for (const e of edges) {
          items.push({
            id: String(e.name || ""),
            score: 0.5,
            leg: "graphiti",
            content: String(e.fact || ""),
            metadata: {
              source: "graphiti_edge",
              valid_at: e.valid_at,
              edge_name: e.name,
            },
          });
          if (items.length >= limit) break;
        }
      }
      done({
        results: items,
        raw: parsed,
        latency_ms: lat,
      });
    });
    const timer = setTimeout(() => {
      proc.kill();
      done({
        results: [],
        raw: {},
        latency_ms: Date.now() - t0,
        error: `graphiti timeout after ${GRAPHITI_TIMEOUT_MS}ms`,
      });
    }, GRAPHITI_TIMEOUT_MS);
  });
}

// --- Metrics emission ---
function emitMetrics(
  query: string,
  routing: RecallRouting,
  latency: RecallLatency,
  errorCode: string | null,
  legResultCounts: Record<string, number>,
): void {
  try {
    if (!fs.existsSync(METRICS_DIR)) {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
    }
    const queryHash = crypto
      .createHash("sha256")
      .update(query)
      .digest("hex")
      .slice(0, 16);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      query_hash: queryHash,
      shape_resolved: routing.shape_resolved,
      shape_source: routing.shape_source,
      legs_queried: routing.legs_queried,
      latency_ms_total: latency.total,
      latency_ms_koi: latency.koi,
      latency_ms_graphiti: latency.graphiti,
      error_code: errorCode,
      leg_result_counts: legResultCounts,
    });
    fs.appendFileSync(METRICS_PATH, line + "\n");
  } catch {
    // metrics emission must NEVER block the caller
  }
}

// --- Main entrypoint ---
export async function recall(input: RecallInput): Promise<RecallResponse> {
  const t0 = Date.now();
  const query = input.query;
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const includeLegs = input.include_legs ?? false;

  // Revert mechanism: route ALL queries to KOI when env disabled.
  const routingEnabled =
    (process.env.RECALL_ROUTING_ENABLED ?? "true").toLowerCase() !== "false";

  // 1. Shape resolution (Strand A4 hybrid).
  let routing: RecallRouting;
  if (!routingEnabled) {
    routing = {
      shape_resolved: "semantic",
      shape_source: "fallback", // env-flag override registered as fallback for observability
      legs_queried: ["koi"],
    };
  } else {
    const r = resolveShape(query, input.shape);
    routing = {
      shape_resolved: r.shape,
      shape_source: r.source,
      legs_queried: r.shape === "semantic" ? ["koi"] : ["graphiti"],
    };
  }

  // 2. Dispatch to leg.
  const latency: RecallLatency = { total: 0, koi: null, graphiti: null };
  let results: RecallResultItem[] = [];
  let errorCode: "substrate_unavailable" | undefined;
  let errorText: string | undefined;
  const legsRaw: Record<string, unknown> = {};

  if (routing.shape_resolved === "semantic") {
    const koi = await queryKoi(query, limit);
    latency.koi = koi.latency_ms;
    if (koi.error) {
      // Both KOI fail = substrate unavailable; Graphiti alone is insufficient.
      errorCode = "substrate_unavailable";
      errorText = koi.error;
    } else {
      results = koi.results;
    }
    if (includeLegs) legsRaw.koi = koi.raw;
  } else {
    // temporal | relationship → Graphiti, with KOI fallback on Graphiti failure.
    const graphiti = await queryGraphiti(query, limit);
    latency.graphiti = graphiti.latency_ms;
    if (graphiti.error || graphiti.results.length === 0) {
      // Fall through to KOI hybrid (acceptable degradation per plan §Strand C).
      const koi = await queryKoi(query, limit);
      latency.koi = koi.latency_ms;
      if (koi.error) {
        errorCode = "substrate_unavailable";
        errorText = `graphiti: ${graphiti.error || "no results"} | koi: ${koi.error}`;
      } else {
        results = koi.results;
        // Mark fallback in routing.
        routing = {
          shape_resolved: routing.shape_resolved,
          shape_source: "fallback",
          legs_queried: ["graphiti", "koi"],
        };
      }
      if (includeLegs) {
        legsRaw.graphiti = graphiti.raw;
        legsRaw.koi = koi.raw;
      }
    } else {
      results = graphiti.results;
      if (includeLegs) legsRaw.graphiti = graphiti.raw;
    }
  }

  latency.total = Date.now() - t0;

  // 3. Emit metrics line (best-effort).
  const legCounts: Record<string, number> = {};
  for (const r of results) {
    legCounts[r.leg] = (legCounts[r.leg] || 0) + 1;
  }
  emitMetrics(query, routing, latency, errorCode || null, legCounts);

  // 4. Build response.
  const resp: RecallResponse = {
    results,
    routing,
    latency_ms: latency,
  };
  if (errorCode) {
    resp.error_code = errorCode;
    resp.error = errorText;
  }
  if (includeLegs) {
    resp.legs = legsRaw;
  }
  return resp;
}

// --- MCP tool definition (mirrors koi-api-tools.ts:1594-1632 pattern) ---
// Not `as const` — the surrounding KOI_API_TOOL_DEFINITIONS array expects
// mutable `Tool` shape (`required: string[]`).
export const RECALL_TOOL_DEFINITION: {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
} = {
  name: "recall",
  description:
    "Route a query by shape across KOI hybrid retrieval (semantic) and Graphiti temporal sidecar (temporal/relationship). Per Tier-2 ratified Strand A4: heuristic resolves shape unless `shape` parameter overrides. Use this in preference to `unified_search` for any question involving validity windows ('when', dates, 'has X been superseded?'), graph-shaped relationships ('what dispatches', 'walk/trace'), or any temporal/relationship reasoning. Falls back to KOI hybrid when Graphiti is unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language query.",
      },
      shape: {
        type: "string",
        enum: ["auto", "semantic", "temporal", "relationship"],
        description:
          "Optional operator-override shape hint. Default 'auto' lets the heuristic decide.",
      },
      limit: {
        type: "number",
        description: "Max results (default 5; max 20).",
      },
      include_legs: {
        type: "boolean",
        description:
          "If true, include per-leg raw responses in the `legs` field for debugging.",
      },
    },
    required: ["query"],
  },
};

/** Handler entry point compatible with `handleKoiApiTool` switch dispatch. */
export async function handleRecallTool(args: Record<string, unknown>) {
  const input: RecallInput = {
    query: String(args.query || ""),
    shape: args.shape as RecallInput["shape"] | undefined,
    limit: typeof args.limit === "number" ? (args.limit as number) : undefined,
    include_legs: Boolean(args.include_legs),
  };
  const resp = await recall(input);
  return {
    content: [{ type: "text", text: JSON.stringify(resp, null, 2) }],
    isError: !!resp.error_code,
  };
}
