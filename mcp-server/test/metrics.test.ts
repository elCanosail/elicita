import assert from 'node:assert/strict';
import test from 'node:test';
import * as metrics from '../src/lib/metrics.js';

test('metrics: records and aggregates buckets', () => {
  metrics.reset();
  metrics.record('search_licitaciones', 'anonymous', '2xx', 42, 30);
  metrics.record('search_licitaciones', 'anonymous', '2xx', 58, 40);
  metrics.record('get_stats', 'anonymous', '5xx', 120, 0);

  const snap = metrics.snapshot();
  assert.equal(snap.length, 2);

  const search = snap.find((b) => b.tool === 'search_licitaciones')!;
  assert.equal(search.count, 2);
  assert.equal(search.avgDurationMs, 50);
  assert.equal(search.avgUpstreamMs, 35);
  assert.equal(search.auth, 'anonymous');
  assert.equal(search.status, '2xx');

  const stats = snap.find((b) => b.tool === 'get_stats')!;
  assert.equal(stats.count, 1);
  assert.equal(stats.avgDurationMs, 120);
  assert.equal(stats.avgUpstreamMs, 0);
  assert.equal(stats.status, '5xx');

  metrics.reset();
});

test('metrics: auth mode changes bucket key', () => {
  metrics.reset();
  metrics.record('search_licitaciones', 'api_key', '2xx', 10);
  metrics.record('search_licitaciones', 'anonymous', '2xx', 20);

  const snap = metrics.snapshot();
  assert.equal(snap.length, 2);
  const keys = snap.map((b) => `${b.tool} ${b.auth} ${b.status}`);
  assert.ok(keys.includes('search_licitaciones api_key 2xx'));
  assert.ok(keys.includes('search_licitaciones anonymous 2xx'));
  metrics.reset();
});

test('metrics: upstream 0 when no upstreamMs on result', () => {
  metrics.reset();
  metrics.record('search_cpv', 'anonymous', '2xx', 5, 0);
  const snap = metrics.snapshot();
  assert.equal(snap[0].avgUpstreamMs, 0);
  metrics.reset();
});

test('metrics: reset clears all buckets', () => {
  metrics.reset();
  metrics.record('get_cobertura', 'anonymous', '2xx', 50);
  assert.equal(metrics.snapshot().length, 1);
  metrics.reset();
  assert.equal(metrics.snapshot().length, 0);
});

test('metrics: no raw request data leaks in snapshot', () => {
  metrics.reset();
  metrics.record('search_licitaciones', 'api_key', '2xx', 100, 80);
  const snap = metrics.snapshot();
  // Snapshot should only contain aggregate fields.
  const keys = Object.keys(snap[0]);
  for (const k of keys) {
    assert.ok(!k.includes('query'), `snapshot should not contain query-like key: ${k}`);
    assert.ok(!k.includes('input'), `snapshot should not contain input-like key: ${k}`);
    assert.ok(!k.includes('body'), `snapshot should not contain body-like key: ${k}`);
    assert.ok(!k.includes('secret'), `snapshot should not contain secret-like key: ${k}`);
  }
  metrics.reset();
});

test('metrics: normTool maps known names', () => {
  assert.equal(metrics.normTool('search_licitaciones'), 'search_licitaciones');
  assert.equal(metrics.normTool('get_stats'), 'get_stats');
  assert.equal(metrics.normTool('get_cobertura'), 'get_cobertura');
  assert.equal(metrics.normTool('search_cpv'), 'search_cpv');
  assert.equal(metrics.normTool('unknown_tool'), 'other');
  assert.equal(metrics.normTool('graph_search'), 'other');
  assert.equal(metrics.normTool('attacker controlled value'), 'other');
});

test('metrics: generateRequestId returns 16 hex chars', () => {
  const id = metrics.generateRequestId();
  assert.ok(/^[0-9a-f]{16}$/.test(id));
  // Two calls should produce different IDs.
  assert.notEqual(metrics.generateRequestId(), id);
});

test('metrics: error status group on isError=true', () => {
  metrics.reset();
  metrics.record('get_stats', 'api_key', '5xx', 200);
  const snap = metrics.snapshot();
  assert.equal(snap[0].status, '5xx');
  metrics.reset();
});

test('metrics: accepts bounded 4xx status bucket', () => {
  metrics.reset();
  metrics.record('search_licitaciones', 'api_key', '4xx', 20, 15);
  assert.equal(metrics.snapshot()[0].status, '4xx');
  metrics.reset();
});
