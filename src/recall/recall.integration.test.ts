#!/usr/bin/env tsx
/**
 * Step 6 integration test — full POC bench replay against `recall()` MCP tool.
 *
 * Calls the `recall` exports directly (per orchestrator: acceptable proxy for
 * Step 6; full MCP-client wiring deferred to Step 7).
 *
 * Pass criteria (per plan AC10):
 *   - ≥4 of 5 POC bench queries land recall@5 ≥ 0.5
 *   - p50 latency ≤ 1500ms
 *   - p95 latency ≤ 3500ms
 *   - Response shape conforms to plan §Strand C "MCP contract"
 *   - Every call writes to ~/.koi/logs/recall-metrics.jsonl
 *
 * Run:  npx tsx src/recall/recall.integration.test.ts
 *
 * Pre-reqs:
 *   - KOI healthy at localhost:8351 (LaunchAgent)
 *   - FalkorDB tier-2 container at localhost:6380
 *   - Step 3 + Step 5 sample-gate ingest already in koi_canon_v1
 *   - OPENAI_API_KEY exported in env
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recall, RecallResponse } from "../tools/recall.js";

interface BenchQuery {
  id: string;
  query: string;
  shape_expected: "semantic" | "temporal" | "relationship";
  ground_truth: string[]; // session UUIDs; empty = null-answer expected
  is_null_answer?: boolean;
}

// Mirror /Users/darrenzal/projects/spore/tmp/session-recall-bench-queries-poc-2026-04-28.yaml
const BENCH: BenchQuery[] = [
  {
    id: "q01",
    query: "ADR-0080 admission F2 translation-mapping-governance defer-with-triggers",
    shape_expected: "semantic",
    ground_truth: [
      "bc5c284d-2d1b-4ba0-9730-d83006480c52",
      "585633a5-238b-402a-8ad4-80206269ce55",
    ],
  },
  {
    id: "q06",
    query: "canon-review v1 wiki intake retrospective",
    shape_expected: "semantic",
    ground_truth: [
      "b776f545-86e5-434d-a755-7be75c56fbce",
      "bc5c284d-2d1b-4ba0-9730-d83006480c52",
    ],
  },
  {
    id: "q08",
    query: "When did F2 transition from candidate to decline-with-triggers?",
    shape_expected: "temporal",
    ground_truth: ["bc5c284d-2d1b-4ba0-9730-d83006480c52"],
  },
  {
    id: "q09",
    query: "Has ADR-0044 been superseded?",
    shape_expected: "temporal",
    ground_truth: [],
    is_null_answer: true,
  },
  {
    id: "q11",
    query:
      "What Agent-tool dispatches occurred during the canon-rebuild Phase 4 work, and what ADRs did each produce?",
    shape_expected: "relationship",
    ground_truth: [
      "bc5c284d-2d1b-4ba0-9730-d83006480c52",
      "585633a5-238b-402a-8ad4-80206269ce55",
    ],
  },
];

const TOP_K = 5;

// --- Helpers ---
function recallAtK(
  resp: RecallResponse,
  groundTruth: string[],
  isNullAnswer: boolean,
  k = TOP_K,
): number {
  const ids = resp.results.slice(0, k).map((r) => {
    return (r.metadata?.session_id as string) || r.id;
  });
  if (isNullAnswer) {
    return ids.length === 0 ? 1.0 : 0.0;
  }
  const matched = ids.filter((id) => groundTruth.includes(id));
  if (groundTruth.length === 0) return 0;
  const denom = Math.min(groundTruth.length, k);
  return matched.length === 0 ? 0 : matched.length / denom;
}

function validateShape(resp: RecallResponse): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!Array.isArray(resp.results)) reasons.push("results not array");
  if (!resp.routing) reasons.push("routing missing");
  if (resp.routing) {
    if (
      !["semantic", "temporal", "relationship"].includes(resp.routing.shape_resolved)
    )
      reasons.push(`shape_resolved invalid: ${resp.routing.shape_resolved}`);
    if (!["auto", "hint", "fallback"].includes(resp.routing.shape_source))
      reasons.push(`shape_source invalid: ${resp.routing.shape_source}`);
    if (!Array.isArray(resp.routing.legs_queried))
      reasons.push("legs_queried not array");
  }
  if (!resp.latency_ms) reasons.push("latency_ms missing");
  if (resp.latency_ms) {
    if (typeof resp.latency_ms.total !== "number")
      reasons.push("latency_ms.total not number");
    // hybrid/walk can be null — that's per spec
  }
  for (const r of resp.results) {
    if (!r.id) {
      reasons.push("result item missing id");
      break;
    }
    if (typeof r.score !== "number") {
      reasons.push("result item score not number");
      break;
    }
    if (!["hybrid", "walk"].includes(r.leg)) {
      reasons.push(`result item leg invalid: ${r.leg}`);
      break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// --- Main ---
async function main() {
  console.log("Step 6 integration test — `recall` MCP tool against POC bench:\n");

  const metricsPathBefore = path.join(os.homedir(), ".koi", "logs", "recall-metrics.jsonl");
  const sizeBefore = fs.existsSync(metricsPathBefore)
    ? fs.statSync(metricsPathBefore).size
    : 0;

  const rows: Array<{
    id: string;
    query: string;
    shape_expected: string;
    shape_resolved: string;
    shape_source: string;
    latency_total: number;
    latency_hybrid: number | null;
    latency_walk: number | null;
    recall_5: number;
    n_results: number;
    shape_ok: boolean;
    error?: string;
    fallback?: boolean;
  }> = [];

  for (const q of BENCH) {
    process.stdout.write(`  [${q.id}] ${q.query.slice(0, 60)}... `);
    const t0 = Date.now();
    let resp: RecallResponse;
    try {
      resp = await recall({ query: q.query, limit: TOP_K });
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
      rows.push({
        id: q.id,
        query: q.query,
        shape_expected: q.shape_expected,
        shape_resolved: "error",
        shape_source: "error",
        latency_total: Date.now() - t0,
        latency_hybrid: null,
        latency_walk: null,
        recall_5: 0,
        n_results: 0,
        shape_ok: false,
        error: (e as Error).message,
      });
      continue;
    }

    const r5 = recallAtK(
      resp,
      q.ground_truth,
      Boolean(q.is_null_answer),
    );
    const validation = validateShape(resp);

    rows.push({
      id: q.id,
      query: q.query,
      shape_expected: q.shape_expected,
      shape_resolved: resp.routing.shape_resolved,
      shape_source: resp.routing.shape_source,
      latency_total: resp.latency_ms.total,
      latency_hybrid: resp.latency_ms.hybrid,
      latency_walk: resp.latency_ms.walk,
      recall_5: r5,
      n_results: resp.results.length,
      shape_ok: validation.ok,
      fallback: resp.routing.shape_source === "fallback",
      error: validation.ok ? undefined : validation.reasons.join("; "),
    });

    console.log(
      `r@5=${r5.toFixed(2)} shape=${resp.routing.shape_resolved}/${resp.routing.shape_source} ` +
        `latency=${resp.latency_ms.total}ms (h=${resp.latency_ms.hybrid}, w=${resp.latency_ms.walk}) ` +
        `n=${resp.results.length}`,
    );
  }

  // Summary table
  console.log("");
  console.log(
    "| Query | Shape resolved/source | recall@5 | latency total/hybrid/walk | shape_ok |",
  );
  console.log(
    "|-------|----------------------|----------|----------------------------|----------|",
  );
  for (const r of rows) {
    const lat = `${r.latency_total}/${r.latency_hybrid ?? "-"}/${r.latency_walk ?? "-"} ms`;
    console.log(
      `| ${r.id} | ${r.shape_resolved}/${r.shape_source} | ${r.recall_5.toFixed(2)} | ${lat} | ${r.shape_ok ? "yes" : "NO: " + (r.error || "")} |`,
    );
  }

  // Aggregate metrics
  const lats = rows.map((r) => r.latency_total).sort((a, b) => a - b);
  const p50 = lats[Math.floor(lats.length * 0.5)];
  const p95 = lats[Math.max(0, Math.floor(lats.length * 0.95) - 1)];
  const passing = rows.filter((r) => r.recall_5 >= 0.5).length;
  const allShapeOk = rows.every((r) => r.shape_ok);

  console.log("");
  console.log(`Recall@5 ≥ 0.5: ${passing}/${rows.length} queries`);
  console.log(`Latency p50: ${p50}ms (target ≤ 1500ms)`);
  console.log(`Latency p95: ${p95}ms (target ≤ 3500ms)`);
  console.log(`Shape conformance: ${allShapeOk ? "PASS" : "FAIL"}`);

  // Metrics emission check
  const sizeAfter = fs.existsSync(metricsPathBefore)
    ? fs.statSync(metricsPathBefore).size
    : 0;
  const grew = sizeAfter > sizeBefore;
  console.log(
    `Metrics emission: ${grew ? "PASS" : "FAIL"} (${metricsPathBefore} grew ${sizeAfter - sizeBefore} bytes)`,
  );

  // AC10 check
  const ac10 = passing >= 4 && p50 <= 1500 && p95 <= 3500 && allShapeOk;
  console.log("");
  console.log(`AC10 (≥4/5 + p50≤1500 + p95≤3500 + shape ok): ${ac10 ? "PASS" : "FAIL"}`);

  if (!ac10) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("integration test crashed:", e);
  process.exit(2);
});
