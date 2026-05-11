// Post-build script: generates per-landing-page OG images.
// Reads public/listy/.manifest.json, writes dist/listy/<path>/og.png for each entry.
// Called by generate-landing-pages.js after HTML generation.

import sharp from 'sharp'
import { readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const MANIFEST_PATH = resolve(ROOT, 'public/listy/.manifest.json')

const WIDTH = 1200
const HEIGHT = 630
const CX = WIDTH / 2

const BG = '#F5F5F8'
const YELLOW = '#6B8000'
const YELLOW_BRIGHT = '#8EA800'
const GREEN = '#2D5A27'
const TEXT_BRIGHT = '#1A1830'
const TEXT_MUTED = '#6B6980'
const BORDER = '#DCDCE8'

const LOGO_H = 160

function escapeXml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function wrapTitle(text, maxCharsPerLine) {
  if (text.length <= maxCharsPerLine) return [text]
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
    return [text.slice(0, maxCharsPerLine), text.slice(maxCharsPerLine).trim()]
  }
  return [line1, words.slice(bestSplit).join(' ')]
}

function formatCount(n) {
  if (!n || n === 0) return null
  return `${n} WYDARZEŃ`
}

async function generateLandingOg(entry, outputPath) {
  const logoPath = resolve(ROOT, 'public/logo-z-napisem.svg')
  const logoSvg = readFileSync(logoPath, 'utf-8')

  const titleRaw = (entry.h1 || 'Lista biegów').toUpperCase()
  const titleLines = wrapTitle(titleRaw, 30)
  const twoLine = titleLines.length > 1

  // Font size: scale down for longer lines
  const maxLineLen = Math.max(...titleLines.map(l => l.length))
  let titleFontSize = 56
  if (maxLineLen > 28) titleFontSize = 48
  if (maxLineLen > 34) titleFontSize = 40
  if (maxLineLen > 40) titleFontSize = 34

  const lineHeight = titleFontSize + 10

  // Vertical layout:
  // Logo: top 60 px, height LOGO_H → bottom edge ~60+LOGO_H
  // Title block center: ~350 (single line) or 330–350 (two lines)
  const titleBlockCenterY = twoLine ? 335 : 350
  const titleStartY = titleBlockCenterY - (titleLines.length * lineHeight) / 2 + titleFontSize

  // Count line below title
  const countY = titleStartY + (titleLines.length - 1) * lineHeight + 60

  const countText = formatCount(entry.eventCount)

  const svgImage = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.10"/>
      <stop offset="40%" stop-color="${GREEN}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="2" fill="transparent"/>
      <rect y="2" width="4" height="2" fill="${GREEN}" opacity="0.018"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#scan)"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="${WIDTH}" height="5" fill="${YELLOW}"/>

  <!-- Title lines -->
  ${titleLines.map((line, i) => {
    const y = titleStartY + i * lineHeight
    return `<text x="${CX}" y="${y}"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="800"
    font-size="${titleFontSize}" letter-spacing="3" text-anchor="middle" fill="${TEXT_BRIGHT}">
    ${escapeXml(line)}
  </text>`
  }).join('\n  ')}

  <!-- Event count -->
  ${countText ? `<text x="${CX}" y="${countY}"
    font-family="'IBM Plex Mono', 'Courier New', monospace" font-weight="400"
    font-size="22" letter-spacing="4" text-anchor="middle" fill="${YELLOW}">
    ${escapeXml(countText)}
  </text>` : ''}

  <!-- Bottom divider -->
  <line x1="0" y1="${HEIGHT - 50}" x2="${WIDTH}" y2="${HEIGHT - 50}" stroke="${BORDER}" stroke-width="1"/>

  <!-- Branding bottom left -->
  <text x="60" y="${HEIGHT - 20}"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="14" letter-spacing="3" fill="${TEXT_MUTED}" opacity="0.5">
    leszy.run/listy
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
  const logoY = 55

  const output = await sharp(baseBuffer)
    .composite([{ input: logoBuffer, left: logoX, top: logoY, blend: 'over' }])
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer()

  await sharp(output).toFile(outputPath)
  return output.length
}

export async function generateAllLandingOgs(distDir) {
  if (!existsSync(MANIFEST_PATH)) {
    console.log('No manifest found — skipping landing OG generation.')
    return
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  const entries = Object.entries(manifest)
  console.log(`Generating OG images for ${entries.length} landing pages…`)

  let done = 0
  for (const [path, entry] of entries) {
    const dir = resolve(distDir, path)
    mkdirSync(dir, { recursive: true })
    const outputPath = resolve(dir, 'og.png')
    await generateLandingOg(entry, outputPath)
    done++
    if (done % 50 === 0) console.log(`  ${done}/${entries.length}`)
  }

  console.log(`Generated ${done} landing OG images.`)
}
