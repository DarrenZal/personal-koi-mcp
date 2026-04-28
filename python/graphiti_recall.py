#!/usr/bin/env python3
"""Graphiti-side recall sidecar for the personal-koi-mcp `recall` tool.

Spawned by `src/tools/recall.ts` as a subprocess (matches the existing
`vault_concept_search` pattern at `src/koi-api-tools.ts:2399`).

CLI:
  graphiti_recall.py --query "<query text>" [--limit 5] [--group-id koi_canon_v1]

Output (JSON to stdout, one object):
  {
    "ok": true,
    "session_ids": ["<uuid>", ...],
    "edges": [{"name": ..., "fact": ..., "valid_at": ..., "score": ...}, ...],
    "n_edges": 12,
    "latency_ms": 1234.5,
    "group_id": "koi_canon_v1"
  }

On failure:
  {"ok": false, "error": "<message>", "error_class": "graphiti_unreachable" | "search_error"}

This is a thin port of `session_recall_bench.py:query_graphiti_python` —
preserves the proven Episodic→MENTIONS-walk fallback while also surfacing
session UUIDs from the explicit RELATES_TO {AUTHORED_WITHIN} edges that
Step 3/Step 5 wrote.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from typing import Any, Optional

# Module-level Graphiti instance reuse not needed — single-shot CLI.
_UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)


async def run_query(query: str, group_id: str, limit: int) -> dict[str, Any]:
    """Run hybrid edge search; surface session UUIDs from edge.fact + episode-walk fallback."""
    if "EMBEDDING_DIM" not in os.environ:
        os.environ["EMBEDDING_DIM"] = "3072"

    try:
        from graphiti_core import Graphiti
        from graphiti_core.driver.falkordb_driver import FalkorDriver
        from graphiti_core.embedder.openai import (
            OpenAIEmbedder,
            OpenAIEmbedderConfig,
        )
    except ImportError as e:
        return {"ok": False, "error": f"graphiti_core import failed: {e}", "error_class": "import_error"}

    # FalkorDriver write/read asymmetry: database == group_id (per ADR + closeout).
    driver = FalkorDriver(host="localhost", port=6380, database=group_id)
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            embedding_model="text-embedding-3-large", embedding_dim=3072
        )
    )
    g = Graphiti(graph_driver=driver, embedder=embedder)

    t0 = time.monotonic()
    try:
        edges = await g.search(
            query=query, group_ids=[group_id], num_results=max(limit * 4, 20)
        )
    except Exception as e:
        try:
            await g.close()
        except Exception:
            pass
        return {
            "ok": False,
            "error": f"graphiti search failed: {e}",
            "error_class": "search_error",
        }

    # Tier-2 Step 6: surface session UUIDs via episode-anchored attribution walk.
    #
    # Architectural note: hybrid edge search returns LLM-extracted edges whose
    # endpoints are LLM-extracted Entity nodes (e.g., "ADR-0080 — Translation-
    # Mapping-Governance" with its own UUID). These do NOT share UUIDs with the
    # explicitly-created ADR-Entity nodes that carry AUTHORED_WITHIN edges
    # (which have UUID-5 deterministic UUIDs derived from rid). The two
    # entity-spaces are deliberately separate (LLM-extracted = content layer;
    # explicit ADR-Entity = structural layer).
    #
    # The bridge between them is the Episodic node: every LLM-extracted edge
    # has an `episodes` list pointing to Episodic nodes; each Episodic carries
    # `source_description = "KOI rid=<rid>"` from the ingest source. We walk:
    #   relevance edge → episode → rid → derive adr_entity_uuid(rid)
    #     → query AUTHORED_WITHIN edges → extract session UUID from edge.fact.
    #
    # This preserves null-answer shape (queries that don't surface ANY relevant
    # episode produce no session attribution) and respects Strand-D's
    # explicit-edge-as-canonical-attribution discipline.
    edges_out: list[dict] = []
    relevant_episode_uuids: list[str] = []
    seen_ep: set[str] = set()
    for e in edges:
        edge_name = getattr(e, "name", "") or ""
        fact_text = getattr(e, "fact", "") or ""
        valid_at = getattr(e, "valid_at", None)
        score = getattr(e, "score", None)
        eps = getattr(e, "episodes", None) or []

        # Skip our own AUTHORED_WITHIN edges in the relevance ranking.
        if edge_name == "AUTHORED_WITHIN":
            continue

        for ep in eps:
            if ep not in seen_ep:
                seen_ep.add(ep)
                relevant_episode_uuids.append(ep)

        edges_out.append(
            {
                "name": edge_name,
                "fact": fact_text[:500],
                "valid_at": str(valid_at) if valid_at is not None else None,
                "score": float(score) if isinstance(score, (int, float)) else None,
                "n_episodes": len(eps),
            }
        )

    # Walk episodes → rid → ADR-Entity → AUTHORED_WITHIN.fact → session UUID.
    session_ids: list[str] = []
    if relevant_episode_uuids:
        try:
            top_episodes = relevant_episode_uuids[:12]
            recs, _, _ = await g.driver.execute_query(
                "MATCH (ep:Episodic) WHERE ep.uuid IN $eps "
                "RETURN ep.uuid AS ep_uuid, ep.source_description AS sd",
                eps=top_episodes,
            )

            # Extract rids in episode-rank order (preserves relevance ranking).
            ep_rid_in_order: list[tuple[str, str]] = []
            seen_rid: set[str] = set()
            ep_to_sd: dict[str, str] = {r.get("ep_uuid"): r.get("sd") or "" for r in recs}
            for ep in top_episodes:
                sd = ep_to_sd.get(ep, "")
                m = re.match(r"KOI rid=(.+)$", sd)
                if not m:
                    continue
                rid = m.group(1)
                if rid in seen_rid:
                    continue
                seen_rid.add(rid)
                ep_rid_in_order.append((ep, rid))

            if ep_rid_in_order:
                # Use rid to compute deterministic ADR-Entity UUID (matches the
                # pattern in graphiti_sustained_write.py:adr_entity_uuid).
                import uuid as _uuid_mod
                _NAMESPACE = _uuid_mod.UUID("12345678-1234-5678-1234-567812345678")
                adr_uuids_in_order: list[str] = []
                for ep, rid in ep_rid_in_order:
                    adr_uuids_in_order.append(
                        str(_uuid_mod.uuid5(_NAMESPACE, f"{group_id}:adr:{rid}"))
                    )

                # One Cypher query for AUTHORED_WITHIN edges across all relevant
                # ADR-Entity UUIDs.
                aw_recs, _, _ = await g.driver.execute_query(
                    "MATCH (n:Entity)-[e:RELATES_TO]->(s:Entity) "
                    "WHERE n.uuid IN $uuids AND e.name = $aw_name "
                    "  AND e.group_id = $gid "
                    "RETURN n.uuid AS adr_uuid, e.fact AS fact",
                    uuids=adr_uuids_in_order,
                    aw_name="AUTHORED_WITHIN",
                    gid=group_id,
                )
                # Group facts by ADR-uuid so we can iterate in episode-rank order.
                adr_to_facts: dict[str, list[str]] = {}
                for r in aw_recs:
                    adr_to_facts.setdefault(r.get("adr_uuid"), []).append(
                        r.get("fact") or ""
                    )

                seen: set[str] = set()
                for adr_u in adr_uuids_in_order:
                    for fact in adr_to_facts.get(adr_u, []):
                        for m in _UUID_RE.finditer(fact):
                            sid = m.group(0).lower()
                            if sid not in seen:
                                seen.add(sid)
                                session_ids.append(sid)
                                if len(session_ids) >= limit:
                                    break
                        if len(session_ids) >= limit:
                            break
                    if len(session_ids) >= limit:
                        break
        except Exception:
            # Walk failure is non-fatal; null-answer shape preserved.
            pass

    try:
        await g.close()
    except Exception:
        pass

    return {
        "ok": True,
        "session_ids": session_ids[:limit],
        "edges": edges_out[:limit],
        "n_edges_total": len(edges),
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        "group_id": group_id,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--group-id", default="koi_canon_v1")
    args = p.parse_args()

    try:
        out = asyncio.run(
            run_query(query=args.query, group_id=args.group_id, limit=args.limit)
        )
    except Exception as e:
        out = {"ok": False, "error": f"unexpected: {e}", "error_class": "unexpected"}

    sys.stdout.write(json.dumps(out, default=str))
    sys.stdout.flush()
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
