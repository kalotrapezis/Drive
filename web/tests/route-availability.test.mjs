import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeMode, routeUnavailable } from '../src/routeAvailability.ts';
test('only executable, online routes can be previewed from the desktop', () => {
  const route = { behavior: 'Copy', keepPolicy: 'Everything', storagePresent: true };
  assert.equal(routeUnavailable(route), '');
  assert.match(routeUnavailable({...route, storagePresent: false}), /mount/);
  assert.equal(routeUnavailable({...route, behavior: 'Move', keepPolicy: 'Nothing'}), '');
  assert.equal(routeUnavailable({...route, keepPolicy: 'Last week'}), '');
  assert.equal(routeUnavailable({...route, stagingMaxBytes: 500}), '');
});

test("saved timed retention routes display Move consistently", () => {
  assert.equal(routeMode({behavior: "Copy", keepPolicy: "Last week"}), "Move");
  assert.equal(routeMode({keepPolicy: "Everything"}), "Copy");
});
