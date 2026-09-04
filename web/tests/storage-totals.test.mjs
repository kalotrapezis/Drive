import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageTotals } from '../src/storageTotals.ts';
test('counts each reported online filesystem once and excludes unknown/offline data', () => {
  assert.deepEqual(storageTotals([
    { id: 'a', identity: 'disk', present: true, bytesTotal: 100, bytesFree: 30 },
    { id: 'b', identity: 'disk', present: true, bytesTotal: 100, bytesFree: 30 },
    { id: 'offline', present: false, bytesTotal: 500, bytesFree: 400 },
    { id: 'unknown', present: true, bytesTotal: 100 },
    { id: 'invalid', present: true, bytesTotal: 20, bytesFree: 30 },
  ]), { total: 100, free: 30, used: 70, excluded: 3 });
  assert.deepEqual(storageTotals([]), { total: 0, free: 0, used: 0, excluded: 0 });
});
