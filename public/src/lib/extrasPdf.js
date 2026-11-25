// The organizer's extras list as a printable PDF (A4 portrait), drawn in the browser with pdf-lib:
// „Do wydania” with an empty „Wydano” box to tick at the bib office, „Podsumowanie” (units per
// variant to prepare) and „Czeka na wpłatę”. The list itself comes from export-event-registrations
// (`kind: 'extras'`, extrasList.js); nothing is counted here. pdf-lib and fontkit are loaded on
// demand, so the panel's bundle does not carry them until somebody exports.

const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN = 36
const BODY = 9
const MIN = 7
const ROW_H = 16
const PAD = 3
const FOOTER = 24

const HANDOUT_COLS = [
  { key: 'bib', title: 'Nr', width: 30 },
  { key: 'name', title: 'Imię i nazwisko', width: 150 },
  { key: 'competition', title: 'Konkurencja', width: 120 },
  { key: 'extra', title: 'Dodatek', width: 100 },
  { key: 'variant', title: 'Wariant', width: 50 },
  { key: 'qty', title: 'Ilość', width: 33, right: true },
  { key: 'done', title: 'Wydano', width: 40, box: true },
]
const AWAITING_COLS = [
  { key: 'bib', title: 'Nr', width: 30 },
  { key: 'name', title: 'Imię i nazwisko', width: 170 },
  { key: 'competition', title: 'Konkurencja', width: 140 },
  { key: 'extra', title: 'Dodatek', width: 100 },
  { key: 'variant', title: 'Wariant', width: 50 },
  { key: 'qty', title: 'Ilość', width: 33, right: true },
]
const TOTAL_COLS = [
  { key: 'extra', title: 'Dodatek', width: 250 },
  { key: 'variant', title: 'Wariant', width: 170 },
  { key: 'count', title: 'Do wydania', width: 103, right: true },
]

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim())

const plDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

const warsawStamp = (d) => d.toLocaleString('pl-PL', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

const personCells = (it) => ({
  bib: it.bib ?? '',
  name: clean(it.name) || [it.firstName, it.lastName].map(clean).filter(Boolean).join(' '),
  competition: [clean(it.competition), clean(it.team?.name ?? it.team)].filter(Boolean).join(' · '),
  extra: it.extra,
  variant: it.variant ?? '—',
  qty: it.qty,
})

/**
 * @param {{ list: { handout: object[], awaiting: object[], totals: object[] }, event: { name?: string, eventDate?: string|null },
 *   filterText?: string|null, generatedAt?: Date, fonts: { regular: Uint8Array, bold: Uint8Array } }} p
 * @returns {Promise<Uint8Array>}
 */
export async function buildExtrasPdf({ list, event, filterText = null, generatedAt = new Date(), fonts }) {
  const [{ PDFDocument, rgb }, fontkitMod] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')])
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkitMod.default ?? fontkitMod)
  const regular = await doc.embedFont(fonts.regular, { subset: true })
  const bold = await doc.embedFont(fonts.bold, { subset: true })
  const black = rgb(0, 0, 0)
  const grey = rgb(0.4, 0.4, 0.4)
  const line = rgb(0.75, 0.75, 0.75)
  const shade = rgb(0.92, 0.92, 0.92)
  doc.setTitle(`Dodatki — ${clean(event?.name)}`)

  let page
  let y
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H])
    y = PAGE_H - MARGIN
  }
  const room = (h) => y - h >= MARGIN + FOOTER

  // A cell's text: 9 pt, else 7 pt when that fits, else 7 pt cut with „…”.
  const fit = (text, font, max) => {
    const t = clean(text)
    if (font.widthOfTextAtSize(t, BODY) <= max) return { t, size: BODY }
    if (font.widthOfTextAtSize(t, MIN) <= max) return { t, size: MIN }
    let cut = t
    while (cut.length > 0 && font.widthOfTextAtSize(`${cut}…`, MIN) > max) cut = cut.slice(0, -1)
    return { t: cut ? `${cut.trimEnd()}…` : '', size: MIN }
  }

  const drawRow = (cols, cells, { font = regular, header = false } = {}) => {
    let x = MARGIN
    const width = cols.reduce((s, c) => s + c.width, 0)
    if (header) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width, height: ROW_H, color: shade })
    for (const c of cols) {
      if (c.box && !header) {
        const s = 9
        page.drawRectangle({ x: x + (c.width - s) / 2, y: y - ROW_H + (ROW_H - s) / 2, width: s, height: s, borderColor: black, borderWidth: 0.8 })
      } else {
        const { t, size } = fit(header ? c.title : cells[c.key], font, c.width - 2 * PAD)
        const w = font.widthOfTextAtSize(t, size)
        const tx = c.box ? x + (c.width - w) / 2 : c.right ? x + c.width - PAD - w : x + PAD
        page.drawText(t, { x: tx, y: y - ROW_H + 5, size, font, color: black })
      }
      x += c.width
    }
    page.drawLine({ start: { x: MARGIN, y: y - ROW_H }, end: { x: MARGIN + width, y: y - ROW_H }, thickness: 0.5, color: line })
    y -= ROW_H
  }

  const heading = (text) => {
    if (!room(14 + 2 * ROW_H)) newPage()
    y -= 10
    page.drawText(text, { x: MARGIN, y: y - 12, size: 12, font: bold, color: black })
    y -= 18
  }

  const table = (cols, rows) => {
    drawRow(cols, null, { font: bold, header: true })
    for (const cells of rows) {
      if (!room(ROW_H)) {
        newPage()
        drawRow(cols, null, { font: bold, header: true })
      }
      drawRow(cols, cells)
    }
  }

  newPage()
  page.drawText(fit(event?.name || 'Wydarzenie', bold, PAGE_W - 2 * MARGIN).t, { x: MARGIN, y: y - 16, size: 16, font: bold, color: black })
  y -= 22
  const sub = [plDate(event?.eventDate), `Wygenerowano ${warsawStamp(generatedAt)}`].filter(Boolean).join(' · ')
  page.drawText(sub, { x: MARGIN, y: y - 10, size: BODY, font: regular, color: grey })
  y -= 14
  if (clean(filterText)) {
    page.drawText(fit(`Filtr: ${filterText}`, regular, PAGE_W - 2 * MARGIN).t, { x: MARGIN, y: y - 10, size: BODY, font: regular, color: grey })
    y -= 14
  }

  const handout = list?.handout ?? []
  const awaiting = list?.awaiting ?? []
  const totals = list?.totals ?? []

  heading('Do wydania')
  if (handout.length) table(HANDOUT_COLS, handout.map(personCells))
  else {
    page.drawText('Brak dodatków do wydania.', { x: MARGIN, y: y - 10, size: BODY, font: regular, color: grey })
    y -= 14
  }

  if (totals.length) {
    heading('Podsumowanie')
    table(TOTAL_COLS, totals.map((t) => ({ extra: t.extra, variant: t.variant ?? '—', count: t.count })))
  }

  if (awaiting.length) {
    heading('Czeka na wpłatę')
    table(AWAITING_COLS, awaiting.map(personCells))
  }

  const pages = doc.getPages()
  pages.forEach((p, i) => {
    const text = `Strona ${i + 1} z ${pages.length}`
    const w = regular.widthOfTextAtSize(text, 8)
    p.drawText(text, { x: PAGE_W - MARGIN - w, y: MARGIN - 10, size: 8, font: regular, color: grey })
  })
  return doc.save()
}

/**
 * Builds the PDF from export-event-registrations' answer and saves it under its filename.
 * @param {{ filename: string, list: object, event: object }} response
 * @param {string|null} filterText the active chips in words, never the search text
 */
export async function downloadExtrasPdf(response, filterText = null) {
  const [{ default: regularUrl }, { default: boldUrl }] = await Promise.all([
    import('../../og-fonts/Rajdhani-Medium.ttf?url'),
    import('../../og-fonts/Rajdhani-SemiBold.ttf?url'),
  ])
  const load = async (url) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error('Nie udało się wczytać czcionki.')
    return new Uint8Array(await res.arrayBuffer())
  }
  const [regular, bold] = await Promise.all([load(regularUrl), load(boldUrl)])
  const bytes = await buildExtrasPdf({ list: response.list, event: response.event, filterText, fonts: { regular, bold } })
  const href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = href
  link.download = response.filename
  link.style.display = 'none'
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // As downloadCsv: revoking at once can cancel the download in Safari.
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
}
