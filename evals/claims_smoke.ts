#!/usr/bin/env tsx
/**
 * Claims Engine MCP Smoke Tests
 *
 * Exercises the claims MCP tool handlers via handleKoiApiTool() — the same
 * code path that Claude calls through MCP.  Setup steps (entity creation,
 * evidence ingestion) use raw HTTP because those are NOT claims tools.
 *
 * Run:  npm run test:claims
 * Env:  KOI_API_ENDPOINT (default http://127.0.0.1:8351)
 */

import axios, { AxiosInstance } from 'axios';
import { handleKoiApiTool } from '../src/koi-api-tools.js';

const BASE_URL = process.env.KOI_API_ENDPOINT || 'http://127.0.0.1:8351';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name} — ${detail}`);
  }
}

/** Parse the JSON text from an MCP tool result. */
function parseToolResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): any {
  const text = result.content[0]?.text || '';
  // anchor_claim prepends a "⏳ Anchor pending:" prefix before the JSON — strip it
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return text;
  try {
    return JSON.parse(text.slice(jsonStart));
  } catch {
    return text;
  }
}

/** Raw HTTP helper for setup steps that aren't claims tools. */
async function rawReq(client: AxiosInstance, method: string, path: string, body?: unknown) {
  try {
    const resp = await client.request({ method, url: path, data: body, validateStatus: () => true });
    return { status: resp.status, data: resp.data };
  } catch (err) {
    return { status: 0, data: { detail: String(err) } };
  }
}

async function main() {
  const client = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 60_000,
  });

  console.log('Claims Engine MCP Smoke Tests (tool-handler level)');
  console.log(`KOI_API_ENDPOINT: ${BASE_URL}`);
  console.log('='.repeat(50));

  // ── 0. Health check (raw — not a claims tool) ──────────────────────
  console.log('\n[0] Health check');
  const { status: hStatus } = await rawReq(client, 'GET', '/health');
  check('server reachable', hStatus === 200, `status=${hStatus}`);
  if (hStatus !== 200) {
    console.log('\n  Server not running. Start with: ~/.config/personal-koi/start.sh');
    process.exit(1);
  }

  // ── 0b. Setup claimant (raw — resolve_entity is not a claims tool) ─
  console.log('\n[0b] Setup: ensure test claimant');
  let claimantUri = '';
  const { data: rData } = await rawReq(client, 'POST', '/entity/resolve', {
    label: 'Claims Engine Test Org',
  });
  if (rData?.candidates?.length) {
    claimantUri = rData.candidates[0].uri;
    check('test claimant found', true);
  } else {
    const { data: cData } = await rawReq(client, 'POST', '/entities/register', {
      entities: [{ name: 'Claims MCP Test Org', type: 'Organization', source: 'claims_smoke_ts' }],
    });
    if (cData?.results?.[0]?.uri) {
      claimantUri = cData.results[0].uri;
      check('test claimant created', true);
    } else {
      const { data: fData } = await rawReq(client, 'POST', '/entity/resolve', {
        label: 'Regen Network', type_hint: 'Organization',
      });
      claimantUri = fData?.candidates?.[0]?.uri || '';
      check('fallback claimant', !!claimantUri, 'No claimant entity available');
      if (!claimantUri) process.exit(1);
    }
  }
  console.log(`  Using claimant: ${claimantUri}`);

  // ── 1. create_claim (MCP tool) ─────────────────────────────────────
  console.log('\n[1] create_claim (MCP tool)');
  const ts = Date.now();
  const createResult = await handleKoiApiTool('create_claim', {
    claimant_uri: claimantUri,
    statement: `MCP smoke test: restored 25 hectares of mangrove habitat (run ${ts})`,
    claim_type: 'ecological',
    metadata: { quantity: 25, unit: 'hectares', sdg_tags: ['SDG14'] },
  });
  check('create_claim not error', !createResult.isError, createResult.content[0]?.text?.slice(0, 200));
  const d1 = parseToolResult(createResult);
  check('claim_rid returned', !!d1?.claim_rid, JSON.stringify(d1)?.slice(0, 200));
  check('verification=self_reported', d1?.verification === 'self_reported', d1?.verification);
  const rid = d1?.claim_rid as string;
  if (!rid) {
    console.log('\n  Claim creation failed. Exiting.');
    process.exit(1);
  }

  // ── 2. search_claims (MCP tool) ────────────────────────────────────
  console.log('\n[2] search_claims (MCP tool)');
  const searchResult = await handleKoiApiTool('search_claims', {
    verification: 'self_reported',
    limit: 5,
  });
  check('search_claims not error', !searchResult.isError, searchResult.content[0]?.text?.slice(0, 200));
  const d2 = parseToolResult(searchResult);
  check('returns array', Array.isArray(d2), typeof d2);
  if (Array.isArray(d2) && d2.length > 0) {
    check('results have claim_rid', !!d2[0].claim_rid, '');
  }

  // ── 3. get_claim (MCP tool) ────────────────────────────────────────
  console.log('\n[3] get_claim (MCP tool)');
  const getResult = await handleKoiApiTool('get_claim', { claim_rid: rid });
  check('get_claim not error', !getResult.isError, getResult.content[0]?.text?.slice(0, 200));
  const d3 = parseToolResult(getResult);
  check('claim_rid matches', d3?.claim_rid === rid, d3?.claim_rid);
  check('statement present', !!d3?.statement, 'empty');
  check('evidence field present', 'evidence' in (d3 || {}), JSON.stringify(Object.keys(d3 || {})));
  check('tx_hash field present', 'tx_hash' in (d3 || {}), JSON.stringify(Object.keys(d3 || {})));

  // ── 4. verify_claim → peer_reviewed (MCP tool) ─────────────────────
  console.log('\n[4] verify_claim → peer_reviewed (MCP tool)');
  const verifyResult1 = await handleKoiApiTool('verify_claim', {
    claim_rid: rid,
    new_level: 'peer_reviewed',
    actor: 'mcp_smoke_test',
    reason: 'MCP smoke test verification',
  });
  check('verify_claim not error', !verifyResult1.isError, verifyResult1.content[0]?.text?.slice(0, 200));
  const d4 = parseToolResult(verifyResult1);
  check('verification=peer_reviewed', d4?.verification === 'peer_reviewed', d4?.verification);

  // ── 5. link_evidence (MCP tool) ────────────────────────────────────
  console.log('\n[5] link_evidence (MCP tool)');
  // Create Evidence entity via raw HTTP (ingest is not a claims tool)
  const { data: evData } = await rawReq(client, 'POST', '/ingest', {
    document_rid: `test://mcp-smoke-evidence-${ts}`,
    source: 'claims_smoke_ts',
    entities: [{
      name: `MCP Smoke Evidence Report ${ts}`,
      type: 'Evidence',
      mentions: [`MCP Smoke Evidence Report ${ts}`],
      confidence: 1.0,
    }],
    relationships: [],
  });
  const evidenceUri = evData?.canonical_entities?.[0]?.uri;
  if (evidenceUri) {
    const linkResult = await handleKoiApiTool('link_evidence', {
      claim_rid: rid,
      evidence_uri: evidenceUri,
      actor: 'mcp_smoke_test',
    });
    check('link_evidence not error', !linkResult.isError, linkResult.content[0]?.text?.slice(0, 200));
    // Verify evidence via get_claim tool
    const getResult2 = await handleKoiApiTool('get_claim', { claim_rid: rid });
    const d5b = parseToolResult(getResult2);
    const evUris = (d5b?.evidence || []).map((e: { uri: string }) => e.uri);
    check('evidence in response', evUris.includes(evidenceUri),
      `expected ${evidenceUri} in ${JSON.stringify(evUris)}`);
  } else {
    check('evidence entity created', false, 'could not create Evidence entity via /ingest');
  }

  // ── 6. verify_claim → verified (MCP tool) ──────────────────────────
  console.log('\n[6] verify_claim → verified (MCP tool)');
  const verifyResult2 = await handleKoiApiTool('verify_claim', {
    claim_rid: rid,
    new_level: 'verified',
    actor: 'mcp_smoke_test',
    reason: 'MCP smoke test full verification',
  });
  check('verify_claim not error', !verifyResult2.isError, verifyResult2.content[0]?.text?.slice(0, 200));
  const d6 = parseToolResult(verifyResult2);
  check('verification=verified', d6?.verification === 'verified', d6?.verification);

  // ── 7. anchor_claim (MCP tool — skip if regen CLI not available) ───
  console.log('\n[7] anchor_claim (MCP tool)');
  const anchorResult = await handleKoiApiTool('anchor_claim', { claim_rid: rid });
  if (anchorResult.isError) {
    const errText = anchorResult.content[0]?.text || '';
    // 503 = regen CLI not available — acceptable in CI
    if (errText.includes('503') || errText.includes('not available') || errText.includes('not found')) {
      check('anchor skipped (regen CLI not available)', true);
      console.log(`  Note: ${errText.slice(0, 200)}`);
    } else {
      check('anchor_claim succeeded', false, errText.slice(0, 300));
    }
  } else {
    const d7 = parseToolResult(anchorResult);
    const rawText = anchorResult.content[0]?.text || '';
    if (rawText.includes('⏳') || d7?.status === 'pending') {
      check('anchor pending (202)', true);
      check('pending has tx_hash', !!d7?.tx_hash, JSON.stringify(d7)?.slice(0, 200));
      check('pending status=pending', d7?.status === 'pending', d7?.status);
      console.log('  Note: Anchor broadcast pending — would need reconcile to finalize');

      // 7b. Test reconcile_claim tool
      console.log('\n[7b] reconcile_claim (MCP tool)');
      const reconcileResult = await handleKoiApiTool('reconcile_claim', { claim_rid: rid });
      check('reconcile_claim not error', !reconcileResult.isError,
        reconcileResult.content[0]?.text?.slice(0, 200));
      const d7b = parseToolResult(reconcileResult);
      check('reconcile has status field', !!d7b?.status, JSON.stringify(d7b)?.slice(0, 200));
    } else {
      check('anchor succeeded (200)', true);
      check('ledger_iri present', !!d7?.ledger_iri, JSON.stringify(d7)?.slice(0, 200));
      check('tx_hash present', !!d7?.tx_hash, JSON.stringify(d7)?.slice(0, 200));
    }
  }

  // ── 8. reconcile_claim — no tx_hash (MCP tool, expect error) ───────
  console.log('\n[8] reconcile_claim — no tx_hash (MCP tool)');
  const ts2 = Date.now();
  // Setup: create a verified claim with no tx_hash (raw HTTP for non-claims steps)
  const { data: rc } = await rawReq(client, 'POST', '/claims/', {
    claimant_uri: claimantUri,
    statement: `Reconcile no-txhash MCP test (run ${ts2})`,
    claim_type: 'ecological',
    metadata: {},
  });
  if (rc?.claim_rid) {
    await rawReq(client, 'PATCH', `/claims/${encodeURIComponent(rc.claim_rid)}/verify`, {
      new_level: 'peer_reviewed', actor: 'test', reason: 'test',
    });
    await rawReq(client, 'PATCH', `/claims/${encodeURIComponent(rc.claim_rid)}/verify`, {
      new_level: 'verified', actor: 'test', reason: 'test',
    });
    const reconcileNoTx = await handleKoiApiTool('reconcile_claim', { claim_rid: rc.claim_rid });
    check('reconcile returns error for no tx_hash', reconcileNoTx.isError === true,
      `isError=${reconcileNoTx.isError}`);
    const errText = reconcileNoTx.content[0]?.text || '';
    check('error mentions tx_hash', errText.includes('tx_hash'), errText.slice(0, 200));
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('All tests passed!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
