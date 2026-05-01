#!/usr/bin/env python3
"""KOI-native recall walk sidecar.

Spawned by `src/tools/recall.ts` for the `walk` leg (temporal + relationship
shape queries). Calls `/knowledge/recall-walk` (PostgreSQL recursive-CTE over
`knowledge_facts` with bi-temporal validity filtering).

History: introduced 2026-04-29 Phase 3 of the koi-graph-consolidation arc as
a drop-in replacement for the prior `graphiti_recall.py` (FalkorDB sidecar);
the FalkorDB sidecar was retired 2026-04-30 Wave 1 close-out, leaving this
file as the sole recall walk sidecar.

CLI:
  koi_recall.py --query "<query text>" [--limit 5] [--group-id koi_canon_v1]
                [--shape semantic|temporal|relationship]

Output (JSON to stdout, one object):
  {
    "ok": true,
    "session_ids": ["<uuid>", ...],
    "edges": [{"name": ..., "fact": ..., "valid_at": ..., "score": ...}, ...],
    "n_edges_total": int,
    "latency_ms": float,
    "group_id": "koi_canon_v1"
  }

On failure:
  {"ok": false, "error": "<message>", "error_class": "koi_unreachable" | "walk_error"}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

import httpx


KOI_BASE_URL = os.environ.get("KOI_API_ENDPOINT", "http://localhost:8351")


def run_query(query: str, group_id: str, limit: int, shape: str) -> dict[str, Any]:
    """POST /knowledge/recall-walk and emit the recall-walk sidecar JSON contract."""
    t0 = time.monotonic()

    # Pre-flight: GET /health (substrate-availability check).
    try:
        h = httpx.get(f"{KOI_BASE_URL}/health", timeout=5.0)
        if h.status_code != 200:
            return {
                "ok": False,
                "error": f"/health returned {h.status_code}",
                "error_class": "koi_unreachable",
            }
        hd = h.json()
        if hd.get("status") != "healthy" or hd.get("database") != "connected":
            return {
                "ok": False,
                "error": f"unhealthy: status={hd.get('status')!r} db={hd.get('database')!r}",
                "error_class": "koi_unreachable",
            }
    except httpx.RequestError as e:
        return {
            "ok": False,
            "error": f"KOI unreachable at {KOI_BASE_URL}: {e}",
            "error_class": "koi_unreachable",
        }

    try:
        r = httpx.post(
            f"{KOI_BASE_URL}/knowledge/recall-walk",
            json={
                "query": query,
                "shape": shape,
                "limit": limit,
                "group_id": group_id,
                "max_hops": 3,
            },
            timeout=30.0,
        )
    except httpx.RequestError as e:
        return {
            "ok": False,
            "error": f"recall-walk request failed: {e}",
            "error_class": "walk_error",
        }
    if r.status_code != 200:
        return {
            "ok": False,
            "error": f"recall-walk {r.status_code}: {r.text[:300]}",
            "error_class": "walk_error",
        }
    data = r.json()

    # Translate /recall-walk shape → recall sidecar JSON contract for
    # src/tools/recall.ts. session_ids preserved at top-level; results mapped
    # to "edges" with name/fact/valid_at/score.
    edges_out: list[dict] = []
    for item in data.get("results", []):
        meta = item.get("metadata") or {}
        if meta.get("source") == "session":
            # Session items are surfaced via session_ids; skip in edges array.
            continue
        edges_out.append(
            {
                "name": meta.get("predicate", ""),
                "fact": item.get("content", ""),
                "valid_at": meta.get("valid_from"),
                "score": item.get("score", 0.0),
                "n_episodes": 1 if meta.get("episode_id") else 0,
            }
        )

    session_ids = data.get("session_ids") or []

    return {
        "ok": True,
        "session_ids": session_ids[:limit],
        "edges": edges_out[:limit],
        "n_edges_total": len(edges_out),
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        "group_id": group_id,
        "walk_path": data.get("walk_path"),
        "latency_breakdown": data.get("latency_ms"),
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--group-id", default="koi_canon_v1")
    p.add_argument(
        "--shape",
        default="semantic",
        choices=["semantic", "temporal", "relationship"],
    )
    args = p.parse_args()

    try:
        out = run_query(
            query=args.query,
            group_id=args.group_id,
            limit=args.limit,
            shape=args.shape,
        )
    except Exception as e:
        out = {"ok": False, "error": f"unexpected: {e}", "error_class": "unexpected"}

    sys.stdout.write(json.dumps(out, default=str))
    sys.stdout.flush()
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
