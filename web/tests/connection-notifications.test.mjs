import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionNotifications } from '../src/connectionNotifications.ts';

test('notifies for an available unconnected storage and a waiting backup', () => {
  const notices = connectionNotifications({
    storages: [{ id: 'local', label: 'Laptop', present: true }, { id: 'disk', label: 'T7', present: true }, { id: 'offline', label: 'Archive', present: false }],
    routes: [{ id: 'photos', contentType: 'Photos', storageId: 'offline', storagePresent: false }],
  });
  assert.deepEqual(notices.map((notice) => notice.id), ['setup-disk', 'waiting-photos']);
  assert.equal(notices[0].action, 'setup');
  assert.equal(notices[1].actionLabel, 'Review connection');
});
