import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { imageHeader } from '../../../supabase/functions/_shared/imageHeader.js'
import { pngBytes, pngHeaderOnly } from '../helpers/images.js'

// Event partners, task 3 (EP-12): the magic bytes alone decide what an upload is and how big it
// claims to be, before anything decodes it.

const u8 = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))))
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]

function riff(fourcc, payload) {
  const chunk = [...Buffer.from(fourcc, 'ascii'), ...le32(payload.length), ...payload]
  return u8(Buffer.from('RIFF'), le32(4 + chunk.length), Buffer.from('WEBP'), chunk)
}

test('PNG: the IHDR decides', () => {
  assert.deepEqual(imageHeader(new Uint8Array(pngBytes(1, 1))), { type: 'png', width: 1, height: 1 })
  assert.deepEqual(imageHeader(new Uint8Array(pngHeaderOnly(50000, 50000))), { type: 'png', width: 50000, height: 50000 })
  assert.equal(imageHeader(new Uint8Array(pngHeaderOnly(10, 10)).slice(0, 20)), null, 'truncated IHDR')
})

test('JPEG: the first SOF marker, skipping DHT, DAC and JPG', () => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const dht = [0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02]
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const jpeg = u8([0xff, 0xd8], app0, dht, sof0, [0xff, 0xda])
  assert.deepEqual(imageHeader(jpeg), { type: 'jpeg', width: 640, height: 480 })
  const progressive = u8([0xff, 0xd8], app0, [0xff, 0xc2, ...sof0.slice(2)])
  assert.deepEqual(imageHeader(progressive), { type: 'jpeg', width: 640, height: 480 })
  assert.equal(imageHeader(u8([0xff, 0xd8], app0)), null, 'no SOF')
  assert.equal(imageHeader(u8([0xff, 0xd8], app0, [0xff, 0xc0, 0x00, 0x11, 8, 0x01])), null, 'truncated SOF')
})

test('WebP: VP8L, VP8 and VP8X', () => {
  const vp8lBits = (10 - 1) | ((20 - 1) << 14)
  assert.deepEqual(imageHeader(riff('VP8L', [0x2f, ...le32(vp8lBits), 0])), { type: 'webp', width: 10, height: 20 })
  const vp8 = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(300), ...le16(150), 0, 0]
  assert.deepEqual(imageHeader(riff('VP8 ', vp8)), { type: 'webp', width: 300, height: 150 })
  const vp8x = [0x10, 0, 0, 0, ...le24(7000 - 1), ...le24(5 - 1)]
  assert.deepEqual(imageHeader(riff('VP8X', vp8x)), { type: 'webp', width: 7000, height: 5 })
  assert.equal(imageHeader(riff('VP8L', [0x2e, 0, 0, 0, 0])), null, 'bad VP8L signature')
  assert.equal(imageHeader(riff('VP8 ', [0x10, 0x02, 0x00, 0x00, 0x00, 0x00, 1, 0, 1, 0])), null, 'bad VP8 start code')
})

test('anything else is null: SVG, GIF, random bytes, empty, not bytes', () => {
  assert.equal(imageHeader(u8(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))), null)
  assert.equal(imageHeader(u8(Buffer.from('GIF89a'), [10, 0, 10, 0, 0, 0, 0])), null)
  assert.equal(imageHeader(new Uint8Array(crypto.randomBytes(10))), null)
  assert.equal(imageHeader(new Uint8Array(0)), null)
  assert.equal(imageHeader('not bytes'), null)
})
