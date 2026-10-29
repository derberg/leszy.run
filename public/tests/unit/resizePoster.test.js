import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resizePoster, posterSize, POSTER_MAX_WIDTH } from '../../src/lib/resizePoster.js'

function fakeCanvasFactory(log) {
  return (width, height) => {
    const canvas = {
      width, height,
      getContext: () => ({
        set fillStyle(v) { log.push(['fillStyle', v]) },
        fillRect: (...a) => log.push(['fillRect', ...a]),
        drawImage: (_img, ...a) => log.push(['drawImage', ...a]),
      }),
      toBlob: (cb, type, quality) => { log.push(['toBlob', type, quality]); cb({ type, size: 1, width: canvas.width, height: canvas.height }) },
    }
    log.push(['canvas', width, height])
    return canvas
  }
}

test('an A4 scan at 300 dpi (3508×4961) becomes a 1600×2263 JPEG at 0.85', async () => {
  const log = []
  let closed = false
  const blob = await resizePoster({ name: 'plakat.png' }, {
    decode: async () => ({ width: 3508, height: 4961, close: () => { closed = true } }),
    createCanvas: fakeCanvasFactory(log),
  })
  assert.deepEqual(log.find((l) => l[0] === 'canvas'), ['canvas', 1600, 2263])
  assert.deepEqual(log.find((l) => l[0] === 'drawImage'), ['drawImage', 0, 0, 1600, 2263])
  assert.deepEqual(log.find((l) => l[0] === 'toBlob'), ['toBlob', 'image/jpeg', 0.85])
  assert.equal(blob.type, 'image/jpeg')
  assert.ok(closed, 'the decoded bitmap is released')
})

test('a transparent PNG is flattened onto white, not black', async () => {
  const log = []
  await resizePoster({}, { decode: async () => ({ width: 1300, height: 1800 }), createCanvas: fakeCanvasFactory(log) })
  const fill = log.findIndex((l) => l[0] === 'fillRect')
  assert.deepEqual(log.find((l) => l[0] === 'fillStyle'), ['fillStyle', '#ffffff'])
  assert.ok(fill >= 0 && fill < log.findIndex((l) => l[0] === 'drawImage'))
})

test('posterSize never upscales and caps the width at 1600', () => {
  assert.equal(POSTER_MAX_WIDTH, 1600)
  assert.deepEqual(posterSize(1300, 1800), { width: 1300, height: 1800 })
  assert.deepEqual(posterSize(1600, 900), { width: 1600, height: 900 })
  assert.deepEqual(posterSize(3508, 4961), { width: 1600, height: 2263 })
})

test('a canvas that yields no blob is an error, not a silent empty upload', async () => {
  await assert.rejects(resizePoster({}, {
    decode: async () => ({ width: 2000, height: 2000 }),
    createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb) => cb(null) }),
  }))
})
