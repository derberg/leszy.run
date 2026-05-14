// Kępa Sport — Małopolska/Podkarpacie timing company.
// Data source: iCal feed at /wydarzenia/?ical=1 (Events Calendar plugin).
// All fields come from the iCal listing — no detail page fetches needed.
// Verified: DTSTART;VALUE=DATE gives clean YYYY-MM-DD; UID numeric prefix is
// a stable WordPress post ID; regulamin PDFs extracted from URL-decoded
// DESCRIPTION (kepasport.pl/wp-content/uploads/*.pdf pattern).
// Registration is embedded on each event page → registration_url = source_url.

const ICAL_URL = 'https://kepasport.pl/wydarzenia/?ical=1'

function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// \b doesn't recognize Polish letters in JS — use manual non-letter boundary
const NB = '[^a-ząćęłńóśźż]'
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// LOCATION: "Tarnów – Park Sanguszków\, Sanguszków 28\, Tarnów\, …"
// Take first comma segment, strip venue qualifier after em-dash.
function parseCity(raw) {
  if (!raw) return null
  const unescaped = raw.replace(/\\,/g, ',')
  const first = unescaped.split(',')[0].trim()
  return first.split(/\s*–\s*/)[0].trim() || null
}

// Unfold iCal continuation lines (lines starting with space/tab belong to previous)
function unfoldLines(text) {
  return text.split('\n').reduce((acc, line) => {
    const l = line.replace(/\r$/, '')
    if ((l.startsWith(' ') || l.startsWith('\t')) && acc.length) {
      acc[acc.length - 1] += l.slice(1)
    } else {
      acc.push(l)
    }
    return acc
  }, [])
}

function parseVEvent(block) {
  const lines = unfoldLines(block)
  const fields = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const rawKey = line.slice(0, colon)
    const val = line.slice(colon + 1)
    const key = rawKey.split(';')[0].trim()
    fields[key] = val
  }
  return fields
}

// Extract the first kepasport PDF URL from URL-decoded DESCRIPTION
function extractRegulaminUrl(description) {
  if (!description) return null
  // Description uses %2F etc. in vc_btn shortcode; decode before searching
  const decoded = description.replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  )
  const m = decoded.match(/https?:\/\/kepasport\.pl\/wp-content\/uploads\/[^\s"'|]+\.pdf/)
  return m ? m[0] : null
}

// DTSTART;VALUE=DATE:20260516 → "2026-05-16"
function parseDate(dtstart) {
  if (!dtstart) return null
  const digits = dtstart.replace(/\D/g, '')
  if (digits.length < 8) return null
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

export async function scrape({ knownIds = new Set() } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const results = []

  try {
    const res = await fetch(ICAL_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) {
      console.error(`[kepasport] iCal feed returned ${res.status}`)
      return results
    }

    const text = await res.text()
    const blocks = text.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g) || []
    console.log(`[kepasport] Found ${blocks.length} events in iCal feed`)

    for (const block of blocks) {
      const f = parseVEvent(block.replace(/^BEGIN:VEVENT\r?\n/, '').replace(/\r?\nEND:VEVENT$/, ''))

      const date = parseDate(f['DTSTART'])
      if (!date || date < today) continue

      const name = f['SUMMARY'] || ''
      if (!name) continue

      // UID: "11693-1778889600-1779062399@kepasport.pl" → "11693"
      const uid = f['UID'] || ''
      const sourceId = uid.split('-')[0]
      if (!sourceId) continue

      const sourceUrl = f['URL'] || null
      const city = parseCity(f['LOCATION'] || '')
      const regulaminUrl = extractRegulaminUrl(f['DESCRIPTION'] || '')

      results.push({
        name,
        date,
        location: city,
        distances: null,
        registration_url: sourceUrl,
        regulamin_url: regulaminUrl,
        website: null,
        is_kids: hasKidsSignal(name),
        event_types: detectEventTypes(name),
        source: 'kepasport',
        source_id: sourceId,
        source_url: sourceUrl,
      })
    }

    console.log(`[kepasport] Scraped ${results.length} future events`)
  } catch (err) {
    console.error(`[kepasport] Scrape failed: ${err.message}`)
  }

  return results
}
