// Shrinks a poster in the browser before upload-registration-file sees it.
// Redrawing onto a canvas keeps only the pixels, so EXIF (GPS, camera, author)
// never leaves the device; the server re-encodes again anyway. The output is
// always JPEG, which is also how a WebP poster reaches the server: the edge
// runtime's image library does not decode WebP.

export const POSTER_MAX_WIDTH = 1600
const QUALITY = 0.85

/** Target size: width capped at 1600 px, aspect kept, never upscaled. */
export function posterSize(width, height) {
  if (width <= POSTER_MAX_WIDTH) return { width, height }
  return { width: POSTER_MAX_WIDTH, height: Math.round((height * POSTER_MAX_WIDTH) / width) }
}

function browserCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * @param {Blob} file the chosen image (jpg, png or webp)
 * @returns {Promise<Blob>} a JPEG at most 1600 px wide
 */
export async function resizePoster(file, { decode = (f) => createImageBitmap(f), createCanvas = browserCanvas } = {}) {
  // createImageBitmap applies the EXIF orientation by default, so a phone
  // photo stays upright after the EXIF block is gone.
  const bitmap = await decode(file)
  const { width, height } = posterSize(bitmap.width, bitmap.height)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff' // JPEG has no alpha: transparency would turn black
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
  if (!blob) throw new Error('Nie udało się przygotować plakatu.')
  return blob
}
