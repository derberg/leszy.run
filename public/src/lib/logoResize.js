// A partner's logo, prepared in the browser for upload-partner-logo. PNG, JPEG and WebP are
// accepted here; the server takes PNG and JPEG only (its image library has no WebP decoder), so
// every file is redrawn onto a canvas and sent as PNG, or as JPEG at 0.9 when that PNG would be
// over the server's 2 MB. Redrawing keeps only the pixels: EXIF never leaves the device. The
// server decodes and re-encodes again anyway; this only spares a refusal and the bandwidth.

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const LOGO_MAX_SIDE = 800
export const LOGO_LIMIT_BYTES = 2 * 1024 * 1024
export const LOGO_TYPE_ERROR = 'Dozwolone: PNG, JPG, WebP.'
export const LOGO_SIZE_ERROR = 'Plik jest za duży (limit 2 MB).'
const JPEG_QUALITY = 0.9

/** Fit inside 800×800, aspect kept, never enlarged. */
export function logoSize(width, height) {
  const scale = Math.min(1, LOGO_MAX_SIDE / width, LOGO_MAX_SIDE / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The decoded size of a base64 data URL, as the server counts it. */
export function dataUrlBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - pad
}

function browserCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * @param {File|Blob} file the chosen image
 * @returns {Promise<string>} a PNG (or, past 2 MB, JPEG) data URL at most 800×800
 */
export async function logoResize(file, { decode = (f) => createImageBitmap(f), createCanvas = browserCanvas } = {}) {
  if (!LOGO_TYPES.includes(file?.type)) throw new Error(LOGO_TYPE_ERROR)
  let bitmap
  try {
    // createImageBitmap applies the EXIF orientation, so a phone photo stays upright.
    bitmap = await decode(file)
  } catch {
    throw new Error('Nie udało się odczytać obrazu.')
  }
  const { width, height } = logoSize(bitmap.width, bitmap.height)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, width, height)
  let url = canvas.toDataURL('image/png')
  if (dataUrlBytes(url) > LOGO_LIMIT_BYTES) {
    // JPEG has no alpha: transparency would turn black, so the logo goes onto white.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    url = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  }
  bitmap.close?.()
  if (dataUrlBytes(url) > LOGO_LIMIT_BYTES) throw new Error(LOGO_SIZE_ERROR)
  return url
}
