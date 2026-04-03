import sharp from 'sharp'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const WIDTH = 1200
const HEIGHT = 630
const CX = WIDTH / 2

// Light theme colors (matching existing OG generator)
const BG = '#F5F5F8'
const YELLOW = '#6B8000'
const YELLOW_BRIGHT = '#8EA800'
const GREEN = '#2D5A27'
const TEXT_BRIGHT = '#1A1830'
const TEXT_MUTED = '#6B6980'
const BORDER = '#DCDCE8'
const CYAN = '#0891B2'

const LOGO_H = 200

const POLISH_MONTHS = [
  'STYCZNIA', 'LUTEGO', 'MARCA', 'KWIETNIA', 'MAJA', 'CZERWCA',
  'LIPCA', 'SIERPNIA', 'WRZEŚNIA', 'PAŹDZIERNIKA', 'LISTOPADA', 'GRUDNIA'
]

function escapeXml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function truncate(str, max) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

function formatPolishDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return ''
  const day = d.getDate()
  const month = POLISH_MONTHS[d.getMonth()]
  const year = d.getFullYear()
  return `${day} ${month} ${year}`
}

function buildBadges(event) {
  const badges = []
  if (event.event_type) {
    badges.push(event.event_type.toUpperCase())
  }
  if (event.distances) {
    const dists = Array.isArray(event.distances) ? event.distances : []
    for (const d of dists.slice(0, 3)) {
      badges.push(String(d))
    }
    if (dists.length > 3) badges.push(`+${dists.length - 3}`)
  }
  return badges
}

/**
 * Generate an OG image for a single calendar event.
 * @param {object} event - Event data (name, date, location, voivodeship, event_type, distances)
 * @param {string} outputPath - Absolute path to write the PNG file
 */
export async function generateEventOg(event, outputPath) {
  const logoPath = resolve(ROOT, 'public/logo-bez-napisu.svg')
  const logoSvg = readFileSync(logoPath, 'utf-8')

  const name = escapeXml(truncate(event.name || 'Wydarzenie', 50).toUpperCase())
  const date = escapeXml(formatPolishDate(event.date))
  const location = escapeXml(truncate(event.location || '', 60))
  const voivodeship = event.voivodeship ? escapeXml(event.voivodeship) : ''
  const locationLine = voivodeship ? `${location} \u00B7 ${voivodeship}` : location
  const badges = buildBadges(event)

  // Badge text elements
  let badgeSvg = ''
  if (badges.length > 0) {
    const badgeY = 520
    const badgeH = 26
    const badgePad = 12
    const badgeGap = 8
    const charWidth = 9 // approximate for 14px font

    // Calculate total width to center
    const badgeWidths = badges.map(b => b.length * charWidth + badgePad * 2)
    const totalWidth = badgeWidths.reduce((a, b) => a + b, 0) + (badges.length - 1) * badgeGap
    let bx = CX - totalWidth / 2

    for (let i = 0; i < badges.length; i++) {
      const w = badgeWidths[i]
      const color = i === 0 ? CYAN : YELLOW
      badgeSvg += `
        <rect x="${bx}" y="${badgeY}" width="${w}" height="${badgeH}" rx="2" fill="none" stroke="${color}" stroke-width="1" opacity="0.6"/>
        <text x="${bx + w / 2}" y="${badgeY + 18}"
          font-family="'Rajdhani', Arial, sans-serif" font-weight="600"
          font-size="14" letter-spacing="1" text-anchor="middle" fill="${color}">
          ${escapeXml(badges[i])}
        </text>`
      bx += w + badgeGap
    }
  }

  const svgImage = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="35%" r="40%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.12"/>
      <stop offset="30%" stop-color="${GREEN}" stop-opacity="0.05"/>
      <stop offset="60%" stop-color="${GREEN}" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="2" fill="transparent"/>
      <rect y="2" width="4" height="2" fill="${GREEN}" opacity="0.015"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#scan)"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="${WIDTH}" height="4" fill="${YELLOW}"/>

  <!-- Event name -->
  <text x="${CX}" y="380"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="800"
    font-size="52" letter-spacing="3" text-anchor="middle" fill="${TEXT_BRIGHT}">
    ${name}
  </text>

  <!-- Date -->
  <text x="${CX}" y="430"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="700"
    font-size="32" letter-spacing="4" text-anchor="middle" fill="${YELLOW}">
    ${date}
  </text>

  <!-- Location + voivodeship -->
  <text x="${CX}" y="475"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="22" letter-spacing="2" text-anchor="middle" fill="${TEXT_MUTED}">
    ${escapeXml(locationLine)}
  </text>

  <!-- Badges -->
  ${badgeSvg}

  <!-- Bottom divider -->
  <line x1="0" y1="${HEIGHT - 50}" x2="${WIDTH}" y2="${HEIGHT - 50}" stroke="${BORDER}" stroke-width="1"/>

  <!-- Branding bottom left -->
  <text x="60" y="${HEIGHT - 20}"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="14" letter-spacing="3" fill="${TEXT_MUTED}" opacity="0.5">
    leszy.run/kalendarz
  </text>

  <!-- Bottom accent bar -->
  <rect x="0" y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${YELLOW}" opacity="0.4"/>
</svg>`

  const logoBuffer = await sharp(Buffer.from(logoSvg))
    .resize({ height: LOGO_H, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  const logoMeta = await sharp(logoBuffer).metadata()
  const logoW = logoMeta.width || LOGO_H

  const baseBuffer = await sharp(Buffer.from(svgImage))
    .resize(WIDTH, HEIGHT)
    .png()
    .toBuffer()

  const logoX = Math.round((WIDTH - logoW) / 2)
  const logoY = 60

  const output = await sharp(baseBuffer)
    .composite([
      {
        input: logoBuffer,
        left: logoX,
        top: logoY,
        blend: 'over',
      },
    ])
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer()

  await sharp(output).toFile(outputPath)

  return { width: WIDTH, height: HEIGHT, bytes: output.length }
}
