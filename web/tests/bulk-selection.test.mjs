import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinationInFolder } from '../src/bulkSelection.ts';

test('bulk copy and move retain each selected filename below the destination folder', () => {
  assert.equal(destinationInFolder('Documents/2026', 'Health Summary.pdf'), 'Documents/2026/Health Summary.pdf');
  assert.equal(destinationInFolder('Documents/2026/', 'Medical/Medication Log.ods'), 'Documents/2026/Medication Log.ods');
});
