import sharp from 'sharp'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const WIDTH = 1200
const HEIGHT = 630
const CX = WIDTH / 2

// Light theme colors (from app.css html.light)
const BG = '#F5F5F8'
const SURFACE = '#FFFFFF'
const YELLOW = '#6B8000'
const YELLOW_BRIGHT = '#8EA800'
const GREEN = '#2D5A27'
const TEXT_BRIGHT = '#1A1830'
const TEXT_MUTED = '#6B6980'
const BORDER = '#DCDCE8'

const logoPath = resolve(ROOT, 'public/logo-bez-napisu.svg')
const logoSvg = readFileSync(logoPath, 'utf-8')

const LOGO_H = 320

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

  <!-- LESZY.RUN -->
  <text x="${CX}" y="450"
    font-family="'Barlow Condensed', Arial, sans-serif" font-weight="800"
    font-size="84" letter-spacing="10" text-anchor="middle" fill="${TEXT_BRIGHT}">
    LESZY<tspan fill="${YELLOW}">.RUN</tspan>
  </text>

  <!-- Tagline -->
  <text x="${CX}" y="500"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="600"
    font-size="22" letter-spacing="6" text-anchor="middle" fill="${TEXT_MUTED}">
    POMIAR CZASU · ZAPISY · WYNIKI NA ŻYWO
  </text>

  <!-- Divider -->
  <line x1="${CX - 120}" y1="525" x2="${CX + 120}" y2="525" stroke="${YELLOW}" stroke-width="1" opacity="0.4"/>

  <!-- Sub-description -->
  <text x="${CX}" y="558"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="18" letter-spacing="3" text-anchor="middle" fill="${TEXT_MUTED}" opacity="0.7">
    KALENDARZ WYDARZEŃ SPORTOWYCH W POLSCE
  </text>

  <!-- Bottom bar -->
  <line x1="0" y1="${HEIGHT - 50}" x2="${WIDTH}" y2="${HEIGHT - 50}" stroke="${BORDER}" stroke-width="1"/>
  <text x="60" y="${HEIGHT - 20}"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="14" letter-spacing="3" fill="${TEXT_MUTED}" opacity="0.5">
    leszy.run
  </text>
  <text x="${WIDTH - 60}" y="${HEIGHT - 20}"
    font-family="'Rajdhani', Arial, sans-serif" font-weight="500"
    font-size="14" letter-spacing="3" fill="${YELLOW}" text-anchor="end" opacity="0.5">
    RFID · LIVE RESULTS
  </text>

  <!-- Bottom accent -->
  <rect x="0" y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${YELLOW}" opacity="0.4"/>
</svg>`

async function generate() {
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

  const outPath = resolve(ROOT, 'public/og-image.png')
  await sharp(output).toFile(outPath)

  const stats = await sharp(outPath).metadata()
  console.log(`OG image generated: ${outPath} (${stats.width}x${stats.height}, ${(output.length / 1024).toFixed(0)}KB)`)
}

generate().catch(err => {
  console.error('Failed to generate OG image:', err)
  process.exit(1)
})
