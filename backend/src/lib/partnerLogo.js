import sharp from 'sharp'

export const MAX_LOGO_BYTES = 2 * 1024 * 1024
export const MAX_LOGO_SIDE = 6000

export class PartnerLogoError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'PartnerLogoError'
    this.status = status
  }
}

const BAD_FORMAT = 'Dozwolone: PNG, JPG, WebP.'
const TOO_BIG = 'Plik jest za duży (limit 2 MB).'
const TOO_WIDE = 'Obraz jest za duży (maks. 6000×6000 px).'

/** Validates by what the bytes ARE (never the claimed mimetype) and re-encodes to a PNG of at most 400x400. */
export async function processPartnerLogo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new PartnerLogoError(BAD_FORMAT)
  if (buf.length > MAX_LOGO_BYTES) throw new PartnerLogoError(TOO_BIG)
  let meta
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_LOGO_SIDE * MAX_LOGO_SIDE }).metadata()
  } catch {
    throw new PartnerLogoError(BAD_FORMAT)
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw new PartnerLogoError(BAD_FORMAT)
  if (!meta.width || !meta.height || meta.width > MAX_LOGO_SIDE || meta.height > MAX_LOGO_SIDE) {
    throw new PartnerLogoError(TOO_WIDE)
  }
  try {
    const png = await sharp(buf, { limitInputPixels: MAX_LOGO_SIDE * MAX_LOGO_SIDE })
      .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    return { png }
  } catch {
    throw new PartnerLogoError(BAD_FORMAT)
  }
}
