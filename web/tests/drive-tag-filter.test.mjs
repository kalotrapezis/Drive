import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesDriveTag } from '../src/driveTagFilter.ts';

test('Drive tag tabs show exact matches and All includes only tagged files', () => {
  assert.equal(matchesDriveTag(['Work', 'Personal'], 'Work'), true);
  assert.equal(matchesDriveTag(['Workshop'], 'Work'), false);
  assert.equal(matchesDriveTag(['Μεταπτυχιακό'], 'Μεταπτυχιακό'), true);
  assert.equal(matchesDriveTag(['Personal'], 'Work'), false);
  assert.equal(matchesDriveTag(['Personal'], ''), true);
  assert.equal(matchesDriveTag([], ''), false);
  assert.equal(matchesDriveTag(undefined, ''), false);
});
