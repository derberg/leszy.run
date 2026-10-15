// The image a runner saves or shares after check-in: the QR code the race
// office scans, plus the name, bib, emoji and T-shirt size, so a screenshot
// or a forwarded WhatsApp message carries everything the runner needs to
// remember. The QR code alone said none of that.

const WIDTH = 1080
const HEIGHT = 1350
const PAD = 80
const QR_SIZE = 520

const COLORS = {
  bg: '#0A0A10',
  yellow: '#BBDD00',
  bright: '#DDDCEC',
  muted: '#8886A0',
  red: '#EF4444',
}

/**
 * What the card says, independent of how it is drawn.
 * @returns {{ eventName: string, eventMeta: string, name: string, bib: string,
 *   emoji: string|null, tshirt: string|null, minor: boolean }}
 */
export function cardContent({ event, participant, minor = false }) {
  const name = [participant?.first_name, participant?.last_name].filter(Boolean).join(' ')
  return {
    eventName: event?.name || '',
    eventMeta: [event?.date, event?.location].filter(Boolean).join(' · '),
    name,
    bib: participant?.bib_number != null && participant.bib_number !== '' ? `#${participant.bib_number}` : '',
    emoji: participant?.emoji || null,
    tshirt: participant?.tshirt_size ? `Odbierz koszulkę: rozmiar ${participant.tshirt_size}` : null,
    minor,
  }
}

export function cardFileName(participant, participantId) {
  return `checkin-${participant?.bib_number || participantId}.png`
}

/**
 * Splits text into lines no wider than maxWidth, by whole words. A single
 * word wider than maxWidth gets a line of its own rather than being cut.
 * @param {(s: string) => number} measure
 */
export function wrapText(text, maxWidth, measure) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && measure(candidate) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * 'share' when the browser can hand this file to the system share sheet
 * (WhatsApp, Messenger, "Save Image" on iOS), 'download' otherwise. Desktop
 * Firefox and most desktop Chrome builds land on 'download'.
 */
export function shareMode(nav, file) {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return 'download'
  try {
    return nav.canShare({ files: [file] }) ? 'share' : 'download'
  } catch {
    return 'download'
  }
}

async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  try {
    await Promise.all([
      document.fonts.load('800 80px "Barlow Condensed"'),
      document.fonts.load('500 40px "Rajdhani"'),
      document.fonts.load('600 40px "Rajdhani"'),
    ])
  } catch {
    // A missing web font falls back to the system font; the card still works.
  }
}

/**
 * Draws the card and resolves to a PNG File.
 * @param {HTMLCanvasElement} qrCanvas  the on-screen QR code, drawn by qrcode.react
 */
export async function renderCheckinCard(qrCanvas, content, fileName) {
  await loadFonts()
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  const maxText = WIDTH - PAD * 2
  const cx = WIDTH / 2

  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.fillStyle = COLORS.yellow
  ctx.fillRect(0, 0, WIDTH, 16)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  let y = PAD + 40

  ctx.fillStyle = COLORS.bright
  ctx.font = '800 64px "Barlow Condensed", sans-serif'
  const titleLines = wrapText(content.eventName.toUpperCase(), maxText, s => ctx.measureText(s).width).slice(0, 2)
  for (const line of titleLines) {
    ctx.fillText(line, cx, y)
    y += 70
  }

  if (content.eventMeta) {
    ctx.fillStyle = COLORS.muted
    ctx.font = '500 34px "Rajdhani", sans-serif'
    ctx.fillText(content.eventMeta, cx, y)
    y += 40
  }

  y += 30
  ctx.fillStyle = COLORS.yellow
  ctx.font = '800 48px "Barlow Condensed", sans-serif'
  ctx.fillText(content.emoji ? `ZAMELDOWANO  ${content.emoji}` : 'ZAMELDOWANO', cx, y)
  y += 30

  // White quiet zone around the code, so it scans off a dark phone screen.
  const box = QR_SIZE + 60
  const boxX = cx - box / 2
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(boxX, y, box, box)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(qrCanvas, boxX + 30, y + 30, QR_SIZE, QR_SIZE)
  y += box + 80

  ctx.fillStyle = COLORS.bright
  ctx.font = '800 60px "Barlow Condensed", sans-serif'
  const nameLine = [content.name, content.bib].filter(Boolean).join('  ')
  ctx.fillText(nameLine, cx, y, maxText)
  y += 60

  if (content.tshirt) {
    ctx.fillStyle = COLORS.yellow
    ctx.font = '600 40px "Rajdhani", sans-serif'
    ctx.fillText(content.tshirt, cx, y, maxText)
    y += 50
  }

  if (content.minor) {
    ctx.fillStyle = COLORS.red
    ctx.font = '600 34px "Rajdhani", sans-serif'
    ctx.fillText('Przynieś podpisaną zgodę opiekuna', cx, y, maxText)
    y += 46
  }

  ctx.fillStyle = COLORS.muted
  ctx.font = '500 32px "Rajdhani", sans-serif'
  ctx.fillText('Pokaż ten kod w biurze zawodów', cx, HEIGHT - PAD + 20)

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob returned null')
  return new File([blob], fileName, { type: 'image/png' })
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
