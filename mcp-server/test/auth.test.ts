import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRequestCredential } from '../src/lib/auth.js';

const API_KEY = `elicita_live_${'a'.repeat(32)}_${'b'.repeat(48)}`;

test('recognizes a direct API key format without verifying it', () => {
  assert.deepEqual(
    resolveRequestCredential({ authorization: `Bearer ${API_KEY}` }),
    { status: 'credential_present', apiKey: API_KEY, credential: 'api_key' }
  );
});

test('rejects malformed and unknown Bearer credentials instead of becoming anonymous', () => {
  assert.deepEqual(
    resolveRequestCredential({ authorization: 'Bearer not-a-valid-credential' }),
    { status: 'invalid', apiKey: '' }
  );
  assert.deepEqual(
    resolveRequestCredential({ authorization: `Bearer elicita_live_${'x'.repeat(32)}_${'y'.repeat(48)}` }),
    { status: 'invalid', apiKey: '' }
  );
  assert.deepEqual(
    resolveRequestCredential({ authorization: `Bearer ${'0'.repeat(64)}` }),
    { status: 'invalid', apiKey: '' }
  );
  assert.deepEqual(resolveRequestCredential({}), { status: 'anonymous', apiKey: '' });
});
