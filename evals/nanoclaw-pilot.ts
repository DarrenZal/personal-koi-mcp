#!/usr/bin/env node --import tsx
/**
 * NanoClaw Pilot Verification
 * Exercises the 3 pilot tools from koi-tool-contract.md § NanoClaw Integration
 */

import { handleKoiApiTool } from '../src/koi-api-tools.js';

async function pilot() {
  console.log('=== NanoClaw Pilot Verification ===');
  console.log('Date:', new Date().toISOString());
  console.log('KOI_API_ENDPOINT:', process.env.KOI_API_ENDPOINT || 'http://127.0.0.1:8351');
  console.log();

  // Tool 1: resolve_entity
  console.log('--- Tool 1: resolve_entity ---');
  const r1 = await handleKoiApiTool('resolve_entity', { label: 'Herring', type_hint: 'Concept' });
  console.log('isError:', r1.isError || false);
  if (r1.isError) {
    console.log('error:', r1.content[0].text.slice(0, 120));
  } else {
    const d1 = JSON.parse(r1.content[0].text);
    console.log('candidates:', d1.candidates?.length || 0);
    if (d1.candidates?.[0]) {
      console.log('top_match:', d1.candidates[0].name, '| uri:', d1.candidates[0].uri, '| confidence:', d1.candidates[0].confidence);
    }
  }
  console.log();

  // Tool 2: koi_search
  console.log('--- Tool 2: koi_search ---');
  const r2 = await handleKoiApiTool('koi_search', { query: 'bioregional knowledge', limit: 3 });
  console.log('isError:', r2.isError || false);
  if (r2.isError) {
    console.log('error:', r2.content[0].text.slice(0, 120));
  } else {
    const d2 = JSON.parse(r2.content[0].text);
    console.log('results:', Array.isArray(d2) ? d2.length : (d2.results?.length || 'N/A'));
    if (Array.isArray(d2) && d2[0]) {
      console.log('first:', d2[0].name || d2[0].label || JSON.stringify(d2[0]).slice(0, 100));
    }
  }
  console.log();

  // Tool 3: knowledge_search
  console.log('--- Tool 3: knowledge_search ---');
  const r3 = await handleKoiApiTool('knowledge_search', { query: 'pattern language', limit: 3 });
  console.log('isError:', r3.isError || false);
  if (r3.isError) {
    console.log('error:', r3.content[0].text.slice(0, 120));
  } else {
    const d3 = JSON.parse(r3.content[0].text);
    console.log('documents:', d3.documents?.length || 0);
    console.log('chunks:', d3.chunks?.length || 0);
    if (d3.documents?.[0]) {
      console.log('first_doc:', d3.documents[0].title || d3.documents[0].source_path || JSON.stringify(d3.documents[0]).slice(0, 100));
    }
  }
  console.log();

  // Summary
  const allPassed = [r1, r2, r3].every(r => r.isError !== true);
  const anyPassed = [r1, r2, r3].some(r => r.isError !== true);
  console.log('=== Summary ===');
  console.log('resolve_entity:', r1.isError ? 'FAIL' : 'OK');
  console.log('koi_search:', r2.isError ? 'FAIL' : 'OK');
  console.log('knowledge_search:', r3.isError ? 'FAIL' : 'OK');
  console.log('Pilot status:', allPassed ? 'ALL PASS' : anyPassed ? 'PARTIAL' : 'ALL FAIL');
}

pilot().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
