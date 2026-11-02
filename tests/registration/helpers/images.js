// Hand-built image bytes for the partner-logo tests: a real (decodable) PNG of any size, and a PNG
// whose IHDR merely claims a size. No image library: the point is to control every byte.
import zlib from 'node:zlib'

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

function ihdr(width, height) {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(width, 0)
  d.writeUInt32BE(height, 4)
  d[8] = 8 // bit depth
  d[9] = 6 // RGBA
  return chunk('IHDR', d)
}

/** A decodable RGBA PNG, width × height, a solid colour. */
export function pngBytes(width, height, rgba = [200, 30, 30, 255]) {
  const row = Buffer.alloc(1 + width * 4)
  for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([SIGNATURE, ihdr(width, height), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Only a PNG signature and an IHDR claiming width × height (a decompression bomb's header). */
export function pngHeaderOnly(width, height) {
  return Buffer.concat([SIGNATURE, ihdr(width, height)])
}

export const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
