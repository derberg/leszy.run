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

const LOGO_H = 170

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

function wrapTitle(text, maxCharsPerLine) {
  if (text.length <= maxCharsPerLine) return [text]
  // Split at word boundary closest to middle
  const words = text.split(/\s+/)
  const mid = Math.ceil(text.length / 2)
  let line1 = ''
  let bestSplit = 0
  for (let i = 0; i < words.length; i++) {
    const candidate = words.slice(0, i + 1).join(' ')
    if (candidate.length <= mid + 5) {
      line1 = candidate
      bestSplit = i + 1
    }
  }
  if (!line1 || bestSplit >= words.length) {
    // Can't split nicely — just hard break
    return [text.slice(0, maxCharsPerLine), text.slice(maxCharsPerLine).trim()]
  }
  return [line1, words.slice(bestSplit).join(' ')]
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
  const types = Array.isArray(event.event_type) ? event.event_type : []
  for (const t of types.filter(t => t !== 'bieg').slice(0, 3)) {
    badges.push(String(t).toUpperCase())
  }
  const dists = Array.isArray(event.distances) ? event.distances : []
  for (const d of dists.slice(0, 3)) {
    badges.push(String(d))
  }
  if (dists.length > 3) badges.push(`+${dists.length - 3}`)
  return badges
}

/**
 * Generate an OG image for a single calendar event.
 * @param {object} event - Event data (name, date, location, voivodeship, event_type, distances)
 * @param {string} outputPath - Absolute path to write the PNG file
 */
export async function generateEventOg(event, outputPath) {
  const output = await renderEventOg(event)
  await sharp(output).toFile(outputPath)
  return { width: WIDTH, height: HEIGHT, bytes: output.length }
}

/**
 * The same image as a PNG buffer. `footer` is the address in the bottom left:
 * a kalendarz page says leszy.run/kalendarz, a leszy.run event page leszy.run.
 * @param {object} event
 * @param {{ footer?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function renderEventOg(event, { footer = 'leszy.run/kalendarz' } = {}) {
  const logoPath = resolve(ROOT, 'public/logo-z-napisem.svg')
  const logoSvg = readFileSync(logoPath, 'utf-8')

  const nameRaw = truncate(event.name || 'Wydarzenie', 70).toUpperCase()
  const nameLines = wrapTitle(nameRaw, 34)
  // Size: 2-line titles get smaller font; single-line scales by length
  const nameFontSize = nameLines.length > 1 ? 32 : (nameRaw.length > 30 ? Math.max(32, Math.floor(1040 / (nameRaw.length * 0.58))) : 48)
  const date = escapeXml(formatPolishDate(event.date))
  const location = escapeXml(truncate(event.location || '', 60))
  const voivodeship = event.voivodeship ? escapeXml(event.voivodeship) : ''
  const locationLine = voivodeship ? `${location} \u00B7 ${voivodeship}` : location
  const badges = buildBadges(event)

  // Badge text elements
  let badgeSvg = ''
  if (badges.length > 0) {
    const badgeY = nameLines.length > 1 ? 450 : 430
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
  ${nameLines.map((line, i) => {
    const baseY = nameLines.length > 1 ? 280 : 300
    const lineY = baseY + i * (nameFontSize + 6)
    return `<text x="${CX}" y="${lineY}"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="800"
    font-size="${nameFontSize}" letter-spacing="${nameFontSize > 36 ? 3 : 2}" text-anchor="middle" fill="${TEXT_BRIGHT}">
    ${escapeXml(line)}
  </text>`
  }).join('\n  ')}

  <!-- Date -->
  <text x="${CX}" y="${nameLines.length > 1 ? 370 : 350}"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="700"
    font-size="28" letter-spacing="4" text-anchor="middle" fill="${YELLOW}">
    ${date}
  </text>

  <!-- Location + voivodeship -->
  <text x="${CX}" y="${nameLines.length > 1 ? 410 : 390}"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="20" letter-spacing="2" text-anchor="middle" fill="${TEXT_MUTED}">
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
    ${escapeXml(footer)}
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

  return output
}

const ROSE = '#BE185D'

// Rajdhani at 22 px averages about 10 px a character, so 84 keeps a line of
// the description inside the 1000 px text column.
const BLURB_LINE_CHARS = 84

function wrapLines(text, maxChars, maxLines) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (next.length <= maxChars) { line = next; continue }
    if (line) lines.push(line)
    line = w
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  return lines.slice(0, maxLines)
}

/**
 * The link preview of a leszy.run event page (/events/:slug): name, date and
 * place, the charity it supports, the start of the organizer's description and
 * what kinds of entry it offers. Every block after the name is optional, and
 * the layout closes up around a missing one.
 * @param {{ name, date, location, charity?: string|null, blurb?: string, tags?: string[] }} event
 * @param {{ footer?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function renderLeszyrunEventOg(event, { footer = 'leszy.run' } = {}) {
  const logoSvg = readFileSync(resolve(ROOT, 'public/logo-z-napisem.svg'), 'utf-8')
  const LOGO = 120

  const nameRaw = truncate(event.name || 'Wydarzenie', 70).toUpperCase()
  const nameLines = wrapTitle(nameRaw, 34)
  const nameSize = nameLines.length > 1 ? 40 : (nameRaw.length > 26 ? 44 : 54)
  const dateLine = [formatPolishDate(event.date), (event.location || '').toUpperCase()].filter(Boolean).join('  ·  ')
  const blurbLines = event.blurb ? wrapLines(event.blurb, BLURB_LINE_CHARS, 2) : []
  const tags = (event.tags || []).slice(0, 4)
  const charity = event.charity != null

  const parts = []
  let y = 60 + LOGO + 64

  for (const line of nameLines) {
    parts.push(`<text x="${CX}" y="${y}" font-family="'Barlow Condensed', Arial, sans-serif" font-weight="800"
      font-size="${nameSize}" letter-spacing="2" text-anchor="middle" fill="${TEXT_BRIGHT}">${escapeXml(line)}</text>`)
    y += nameSize + 6
  }

  if (dateLine) {
    y += 4
    parts.push(`<text x="${CX}" y="${y}" font-family="'Barlow Condensed', Arial, sans-serif" font-weight="700"
      font-size="26" letter-spacing="3" text-anchor="middle" fill="${YELLOW}">${escapeXml(truncate(dateLine, 70))}</text>`)
    y += 26
  }

  if (charity) {
    const label = event.charity ? `CHARYTATYWNIE  ·  ${truncate(event.charity, 56)}` : 'BIEG CHARYTATYWNY'
    const textW = label.length * 9.4
    const w = textW + 28 + 34
    const x = CX - w / 2
    y += 22
    // A heart drawn as a path: the bundled fonts have no ♥ glyph.
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="34" rx="2" fill="${ROSE}" fill-opacity="0.08" stroke="${ROSE}" stroke-opacity="0.5"/>
      <path transform="translate(${x + 16} ${y + 10}) scale(0.6)" fill="${ROSE}"
        d="M12 21s-7.5-4.6-10-9.3C.3 8.3 2.2 4 6 4c2.3 0 4 1.5 6 3.6C14 5.5 15.7 4 18 4c3.8 0 5.7 4.3 4 7.7C19.5 16.4 12 21 12 21z"/>
      <text x="${x + 42}" y="${y + 23}" font-family="'Rajdhani', Arial, sans-serif" font-weight="600"
        font-size="17" letter-spacing="1" fill="${ROSE}">${escapeXml(label)}</text>`)
    y += 34
  }

  if (blurbLines.length) {
    y += charity ? 46 : 40
    for (const line of blurbLines) {
      parts.push(`<text x="${CX}" y="${y}" font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
        font-size="22" text-anchor="middle" fill="${TEXT_MUTED}">${escapeXml(line)}</text>`)
      y += 28
    }
    y -= 28
  }

  if (tags.length) {
    y += 30
    const widths = tags.map(t => t.length * 10.5 + 30)
    const total = widths.reduce((a, b) => a + b, 0) + (tags.length - 1) * 10
    let bx = CX - total / 2
    tags.forEach((t, i) => {
      parts.push(`<rect x="${bx}" y="${y}" width="${widths[i]}" height="30" rx="2" fill="none" stroke="${CYAN}" stroke-opacity="0.6"/>
        <text x="${bx + widths[i] / 2}" y="${y + 21}" font-family="'Rajdhani', Arial, sans-serif" font-weight="600"
          font-size="16" letter-spacing="2" text-anchor="middle" fill="${CYAN}">${escapeXml(t)}</text>`)
      bx += widths[i] + 10
    })
    y += 30
  }

  // Centre the logo and the blocks in the space above the footer, so an event
  // with only a name and a date does not leave the lower half empty.
  const dy = Math.max(0, Math.round((HEIGHT - 50 - y - 44) / 2) - 10)

  const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="30%" r="45%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.10"/>
      <stop offset="60%" stop-color="${GREEN}" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${WIDTH}" height="4" fill="${YELLOW}"/>
  <g transform="translate(0 ${dy})">
  ${parts.join('\n  ')}
  </g>
  <line x1="0" y1="${HEIGHT - 50}" x2="${WIDTH}" y2="${HEIGHT - 50}" stroke="${BORDER}" stroke-width="1"/>
  <text x="60" y="${HEIGHT - 20}" font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="14" letter-spacing="3" fill="${TEXT_MUTED}" opacity="0.6">${escapeXml(footer)}</text>
  <text x="${WIDTH - 60}" y="${HEIGHT - 20}" font-family="'Rajdhani', Arial, sans-serif" font-weight="600"
    font-size="14" letter-spacing="3" text-anchor="end" fill="${YELLOW}">ZAPISY · WYNIKI NA ŻYWO</text>
  <rect x="0" y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${YELLOW}" opacity="0.4"/>
</svg>`

  const logo = await sharp(Buffer.from(logoSvg))
    .resize({ height: LOGO, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()
  const logoW = (await sharp(logo).metadata()).width || LOGO
  const base = await sharp(Buffer.from(svg)).resize(WIDTH, HEIGHT).png().toBuffer()
  return sharp(base)
    .composite([{ input: logo, left: Math.round((WIDTH - logoW) / 2), top: 44 + dy }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}
