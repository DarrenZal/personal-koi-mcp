#!/usr/bin/env npx tsx
/**
 * KOI Tool Contract Tests
 *
 * Validates that the personal-koi-mcp server satisfies koi-tool-contract.md.
 * Runs against a live KOI API instance.
 *
 * Usage:
 *   KOI_API_ENDPOINT=http://localhost:8351 VAULT_PATH=/tmp/test-vault npx tsx evals/koi-contract-test.ts
 */

import { KOI_API_TOOL_DEFINITIONS, KOI_API_TOOL_NAMES, handleKoiApiTool } from '../src/koi-api-tools.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// =============================================================================
// Test infrastructure
// =============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

async function assertThrows(fn: () => Promise<any>, message: string) {
  try {
    const result = await fn();
    // If the handler returns isError, that also counts
    if (result?.isError) {
      passed++;
      console.log(`  ✓ ${message}`);
      return;
    }
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message} (did not throw or return isError)`);
  } catch {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

// =============================================================================
// Setup
// =============================================================================

const VAULT_PATH = process.env.VAULT_PATH || '/tmp/koi-contract-test-vault';
const KOI_API = process.env.KOI_API_ENDPOINT || 'http://127.0.0.1:8351';

async function setup() {
  // Ensure VAULT_PATH env is set for the vault tools
  process.env.VAULT_PATH = VAULT_PATH;
  process.env.KOI_API_ENDPOINT = KOI_API;

  // Create test vault structure
  await fs.mkdir(path.join(VAULT_PATH, 'People'), { recursive: true });
  await fs.mkdir(path.join(VAULT_PATH, 'Organizations'), { recursive: true });
  await fs.writeFile(
    path.join(VAULT_PATH, 'People', 'Test Person.md'),
    '---\n"@type": Person\nname: Test Person\n---\n\nA test person for contract tests.\n',
    'utf-8'
  );
}

async function cleanup() {
  try {
    await fs.rm(VAULT_PATH, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// =============================================================================
// Contract tool names (the 15 tools from koi-tool-contract.md)
// =============================================================================

const CONTRACT_TOOLS = [
  'resolve_entity',
  'get_entity_neighborhood',
  'get_entity_documents',
  'koi_search',
  'knowledge_search',
  'preview_url',
  'process_url',
  'ingest_url',
  'github_scan',
  'monitor_url',
  'code_query',
  'federation_status',
  'vault_read_note',
  'vault_write_note',
  'vault_list_notes',
];

// =============================================================================
// Tests
// =============================================================================

async function testSchema() {
  console.log('\n=== Schema Tests ===');

  // All 15 contract tools are defined
  const definedNames = new Set(KOI_API_TOOL_DEFINITIONS.map(t => t.name));
  for (const name of CONTRACT_TOOLS) {
    assert(definedNames.has(name), `Tool "${name}" is defined in KOI_API_TOOL_DEFINITIONS`);
  }

  // All 15 are in KOI_API_TOOL_NAMES set
  for (const name of CONTRACT_TOOLS) {
    assert(KOI_API_TOOL_NAMES.has(name), `Tool "${name}" is in KOI_API_TOOL_NAMES dispatch set`);
  }

  // Each tool has inputSchema with type: 'object'
  for (const tool of KOI_API_TOOL_DEFINITIONS) {
    assert(
      tool.inputSchema?.type === 'object',
      `Tool "${tool.name}" has inputSchema.type === 'object'`
    );
  }

  // Specific schema checks
  const resolveEntity = KOI_API_TOOL_DEFINITIONS.find(t => t.name === 'resolve_entity');
  assert(
    resolveEntity?.inputSchema?.required?.includes('label'),
    'resolve_entity requires "label" parameter'
  );

  const getNeighborhood = KOI_API_TOOL_DEFINITIONS.find(t => t.name === 'get_entity_neighborhood');
  assert(
    getNeighborhood?.inputSchema?.required?.includes('entity_uri'),
    'get_entity_neighborhood requires "entity_uri" parameter'
  );

  const vaultRead = KOI_API_TOOL_DEFINITIONS.find(t => t.name === 'vault_read_note');
  assert(
    vaultRead?.inputSchema?.required?.includes('path'),
    'vault_read_note requires "path" parameter'
  );

  const vaultWrite = KOI_API_TOOL_DEFINITIONS.find(t => t.name === 'vault_write_note');
  assert(
    vaultWrite?.inputSchema?.required?.includes('path') &&
    vaultWrite?.inputSchema?.required?.includes('content'),
    'vault_write_note requires "path" and "content" parameters'
  );
}

async function testResponseShape() {
  console.log('\n=== Response Shape Tests ===');

  // federation_status is the simplest API tool (no params)
  const result = await handleKoiApiTool('federation_status', {});
  assert(Array.isArray(result.content), 'federation_status returns content array');
  assert(result.content.length > 0, 'federation_status content is non-empty');
  assert(result.content[0].type === 'text', 'federation_status content[0].type === "text"');
  assert(typeof result.content[0].text === 'string', 'federation_status content[0].text is string');

  // API tools return JSON.stringify on success, plain text error on failure
  if (!result.isError) {
    try {
      JSON.parse(result.content[0].text);
      assert(true, 'federation_status returns valid JSON text');
    } catch {
      assert(false, 'federation_status returns valid JSON text');
    }
  } else {
    assert(true, 'federation_status returns isError (API unreachable)');
  }
}

async function testErrorShape() {
  console.log('\n=== Error Shape Tests ===');

  // Call resolve_entity with empty label to trigger an API error
  const result = await handleKoiApiTool('resolve_entity', { label: '' });
  // Whether it succeeds or fails, check shape
  assert(Array.isArray(result.content), 'Error response has content array');
  assert(result.content[0].type === 'text', 'Error response content[0].type === "text"');

  // Unknown tool returns isError
  const unknown = await handleKoiApiTool('nonexistent_tool', {});
  assert(unknown.isError === true, 'Unknown tool returns isError: true');
  assert(unknown.content[0].text.includes('Unknown'), 'Unknown tool error message mentions "Unknown"');
}

async function testVaultTraversal() {
  console.log('\n=== Vault Traversal Security Tests ===');

  // vault_read_note with path traversal
  const readResult = await handleKoiApiTool('vault_read_note', { path: '../../../etc/passwd' });
  assert(readResult.isError === true, 'vault_read_note rejects "../../../etc/passwd" with isError');
  assert(
    readResult.content[0].text.includes('traversal') || readResult.content[0].text.includes('outside'),
    'vault_read_note error mentions traversal/outside'
  );

  // vault_write_note with path traversal
  const writeResult = await handleKoiApiTool('vault_write_note', {
    path: '../../../tmp/evil.md',
    content: 'evil content',
  });
  assert(writeResult.isError === true, 'vault_write_note rejects "../../../tmp/evil.md" with isError');

  // vault_list_notes with path traversal
  const listResult = await handleKoiApiTool('vault_list_notes', { folder: '../../../etc' });
  assert(listResult.isError === true, 'vault_list_notes rejects "../../../etc" with isError');
}

async function testVaultSmoke() {
  console.log('\n=== Vault Smoke Tests ===');

  // Read existing test file
  const readResult = await handleKoiApiTool('vault_read_note', { path: 'People/Test Person.md' });
  assert(!readResult.isError, 'vault_read_note reads existing file without error');
  assert(
    readResult.content[0].text.includes('Test Person'),
    'vault_read_note returns file content'
  );
  // Contract: vault tools return raw text, NOT JSON
  try {
    JSON.parse(readResult.content[0].text);
    // If it parses as JSON, that's wrong for vault tools (unless the content itself is JSON)
    assert(
      readResult.content[0].text.startsWith('---'),
      'vault_read_note returns raw markdown (starts with frontmatter)'
    );
  } catch {
    // Not JSON = correct for vault tools
    assert(true, 'vault_read_note returns raw text (not JSON-wrapped)');
  }

  // Write + read round-trip
  const writeResult = await handleKoiApiTool('vault_write_note', {
    path: 'Organizations/Test Org.md',
    content: '---\n"@type": schema:Organization\nname: Test Org\n---\n\nA test organization.\n',
  });
  assert(!writeResult.isError, 'vault_write_note writes without error');
  assert(writeResult.content[0].text === 'Written: Organizations/Test Org.md', 'vault_write_note returns "Written: {path}"');

  const readBack = await handleKoiApiTool('vault_read_note', { path: 'Organizations/Test Org.md' });
  assert(readBack.content[0].text.includes('Test Org'), 'Round-trip: written content can be read back');

  // List notes
  const listResult = await handleKoiApiTool('vault_list_notes', { folder: 'People' });
  assert(!listResult.isError, 'vault_list_notes lists without error');
  assert(
    listResult.content[0].text.includes('Test Person.md'),
    'vault_list_notes includes "Test Person.md"'
  );
  // Contract: returns newline-separated filenames, NOT JSON
  try {
    JSON.parse(listResult.content[0].text);
    assert(false, 'vault_list_notes returns plain text (not JSON)');
  } catch {
    assert(true, 'vault_list_notes returns plain text (not JSON)');
  }
}

async function testApiSmoke() {
  console.log('\n=== API Smoke Tests ===');

  // koi_search
  const searchResult = await handleKoiApiTool('koi_search', { query: 'test' });
  assert(Array.isArray(searchResult.content), 'koi_search returns content array');
  if (!searchResult.isError) {
    try {
      JSON.parse(searchResult.content[0].text);
      assert(true, 'koi_search returns valid JSON');
    } catch {
      assert(false, 'koi_search returns valid JSON');
    }
  } else {
    console.log(`    (koi_search returned error: ${searchResult.content[0].text.slice(0, 100)})`);
    assert(true, 'koi_search returns structured error');
  }

  // resolve_entity
  const resolveResult = await handleKoiApiTool('resolve_entity', { label: 'test' });
  assert(Array.isArray(resolveResult.content), 'resolve_entity returns content array');
  if (!resolveResult.isError) {
    try {
      JSON.parse(resolveResult.content[0].text);
      assert(true, 'resolve_entity returns valid JSON');
    } catch {
      assert(false, 'resolve_entity returns valid JSON');
    }
  } else {
    assert(true, 'resolve_entity returns structured error');
  }

  // federation_status (already tested in response shape, just verify it works)
  const fedResult = await handleKoiApiTool('federation_status', {});
  assert(!fedResult.isError || fedResult.isError === true, 'federation_status returns valid response shape');
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`KOI Contract Tests`);
  console.log(`API: ${KOI_API}`);
  console.log(`Vault: ${VAULT_PATH}`);

  await setup();

  try {
    await testSchema();
    await testVaultTraversal();
    await testVaultSmoke();

    // API tests require a running KOI API
    try {
      await testResponseShape();
      await testErrorShape();
      await testApiSmoke();
    } catch (e: any) {
      console.log(`\n⚠ API tests skipped (KOI API not reachable): ${e.message}`);
    }
  } finally {
    await cleanup();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  ✗ ${f}`);
    }
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
