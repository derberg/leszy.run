// What an uploaded image is and how big it says it is, read from its magic bytes and header only,
// never from a data URL's MIME type or a file name. Run BEFORE anything decodes the bytes: a
// 50000×50000 PNG is a few hundred bytes and decodes to 10 GB. Plain ESM, no Deno APIs (node tests
// import it).

/**
 * @param {Uint8Array} bytes
 * @returns {{ type: 'png'|'jpeg'|'webp', width: number, height: number } | null}
 *   null for anything else, or a header that is truncated or malformed
 */
export function imageHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) return null
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const be16 = (b, i) => (b[i] << 8) | b[i + 1]
const le16 = (b, i) => b[i] | (b[i + 1] << 8)
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n))

// The first chunk must be IHDR (length 13): width and height at bytes 16 and 20.
function png(b) {
  if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) return null
  if (be32(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null
  const width = be32(b, 16)
  const height = be32(b, 20)
  return width > 0 && height > 0 ? { type: 'png', width, height } : null
}

// Walk the marker segments to the first SOF0–SOF15; C4 (DHT), C8 (JPG) and CC (DAC) share that
// range and are not frame headers.
function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker === 0xd9 || marker === 0xda) return null // end of image or scan before any frame header
    const length = be16(b, i + 2)
    if (length < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7 || i + 9 > b.length) return null
      const height = be16(b, i + 5)
      const width = be16(b, i + 7)
      return width > 0 && height > 0 ? { type: 'jpeg', width, height } : null
    }
    i += 2 + length
  }
  return null
}

// RIFF....WEBP, then the first chunk: VP8 (lossy), VP8L (lossless) or VP8X (extended).
function webp(b) {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  const d = 20
  let width, height
  const need = { 'VP8 ': 10, VP8L: 5, VP8X: 10 }[chunk]
  if (!need || b.length < d + need) return null
  if (chunk === 'VP8 ') {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null
    width = le16(b, d + 6) & 0x3fff
    height = le16(b, d + 8) & 0x3fff
  } else if (chunk === 'VP8L') {
    if (b[d] !== 0x2f) return null
    const bits = (b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16) | (b[d + 4] << 24)) >>> 0
    width = (bits & 0x3fff) + 1
    height = ((bits >>> 14) & 0x3fff) + 1
  } else {
    width = le24(b, d + 4) + 1
    height = le24(b, d + 7) + 1
  }
  return width > 0 && height > 0 ? { type: 'webp', width, height } : null
}
