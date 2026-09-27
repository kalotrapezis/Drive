const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pairMotion, embeddedVideoOffset } = require('../library')

test('a picture and its seconds of video show as one; a video of its own stays', () => {
  let id = 0
  const m = (path, is_video = 0) => ({ id: ++id, path, is_video })
  const list = [m('Card/MVIMG_1.jpg'), m('Card/MVIMG_1.MP4', 1), m('Card/20230529_201908.heic'), m('Card/20230529_201908(2).MP4', 1),
    m('Pixel/PXL_2.MP.jpg'), m('Pixel/PXL_2.mp4', 1), m('Card/holiday.mp4', 1), m('Other/MVIMG_1.MP4', 1)]
  const out = pairMotion(list)
  assert.deepEqual(out.map(x => x.path), ['Card/MVIMG_1.jpg', 'Card/20230529_201908.heic', 'Pixel/PXL_2.MP.jpg', 'Card/holiday.mp4', 'Other/MVIMG_1.MP4'])
  assert.deepEqual(out.filter(x => x.motion).map(x => [x.path, x.motion]), [['Card/MVIMG_1.jpg', 2], ['Card/20230529_201908.heic', 4], ['Pixel/PXL_2.MP.jpg', 6]])
})

test('the video inside a motion photo is found after the picture, and only a real MP4 counts', () => {
  const box = brand => { const b = Buffer.alloc(24); b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'latin1'); b.write(brand, 8, 'latin1'); return b }
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100, 7), Buffer.from('ftyp in the text'), Buffer.from([0xff, 0xd9])])
  const photo = Buffer.concat([jpeg, box('mp42'), Buffer.alloc(50)])
  assert.equal(embeddedVideoOffset(photo), jpeg.length)
  assert.equal(embeddedVideoOffset(jpeg), -1)
  const heic = Buffer.concat([box('heic'), Buffer.alloc(40)]) // a HEIC's own ftyp is not a video
  assert.equal(embeddedVideoOffset(heic), -1)
  assert.equal(embeddedVideoOffset(Buffer.concat([heic, box('isom')])), heic.length)
})
