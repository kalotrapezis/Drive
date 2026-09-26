import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isScreenshot } from '../src/photoCollections.ts';
test('screenshots are grouped by folder without guessing from names', () => {
  assert.equal(isScreenshot({path:'Pictures/Screenshots/a.png',type:'Photo'}),true);
  assert.equal(isScreenshot({path:'DCIM/Camera/Screenshot_1.jpg',type:'Photo'}),false);
  assert.equal(isScreenshot({path:'Screenshots/movie.mp4',type:'Video'}),false);
  assert.equal(isScreenshot({path:'Pictures/screenshots/a.png',type:'Photo'}),true);
});
