// The link preview of /events/:slug. A crawler (Facebook, Messenger, Slack,
// Google) reads only the HTML it is served and runs no JavaScript, so useSeo()
// never reaches it: without this every upcoming event shared as the homepage,
// "Leszy.run — Pomiar czasu i obsługa biegów". api/event-page.js serves the SPA
// shell through injectShareMeta(), and api/event-og.js draws the image.
//
// No imports: both run as Vercel Functions.

export const SITE = 'https://www.leszy.run'

// Same rule as api/event.js.
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isEventSlug(slug) {
  return typeof slug === 'string' && slug.length >= 3 && slug.length <= 80 && SLUG.test(slug)
}

const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia']

/** '2027-04-18' → '18 kwietnia 2027'; anything else → ''. */
export function polishDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  if (!m) return ''
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : ''
}

/**
 * What the preview says about one event. A registration event (the
 * registration_public() document) wins over the bare `events` row, which is
 * all a past or registration-less event has.
 * @returns {{ name, date, location, description, noindex, distances } | null}
 */
export function eventShareFields(registration, eventRow) {
  if (registration?.name) {
    const distances = [...new Set((registration.competitions || [])
      .map(c => c.distanceLabel).filter(Boolean))]
    return {
      name: registration.name,
      date: (registration.eventDate || '').slice(0, 10),
      location: registration.town?.label || '',
      description: registration.description || '',
      noindex: registration.listed === false,
      distances,
      charity: registration.isCharity ? (registration.charityGoal || '') : null,
      tags: competitionTags(registration.competitions),
    }
  }
  if (eventRow?.name && (eventRow.visibility === 'public' || eventRow.visibility === 'unlisted')) {
    return {
      name: eventRow.name,
      date: (eventRow.date || '').slice(0, 10),
      location: eventRow.location || '',
      description: '',
      noindex: eventRow.visibility !== 'public',
      distances: [],
      charity: null,
      tags: [],
    }
  }
  return null
}

/**
 * What kinds of entry the event offers, for the image's chips: the
 * disciplines, then children and teams. Never one chip per competition.
 */
export function competitionTags(competitions) {
  const list = competitions || []
  const tags = []
  if (list.some(c => c.discipline === 'run')) tags.push('BIEG')
  if (list.some(c => c.discipline === 'nw')) tags.push('NORDIC WALKING')
  if (list.some(c => c.isKids)) tags.push('DZIECI')
  if (list.some(c => c.kind === 'team')) tags.push('DRUŻYNY')
  return tags
}

/** The organizer's description cut to `max` characters at a word, on one line of whitespace. */
export function shortBlurb(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const atWord = cut.lastIndexOf(' ') > max * 0.6 ? cut.slice(0, cut.lastIndexOf(' ')) : cut
  return atWord.replace(/[\s,.;:–—-]+$/, '') + '…'
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** The SPA shell with the event's title, description, canonical, robots and Open Graph tags. */
export function injectShareMeta(shell, fields, slug) {
  const date = polishDate(fields.date)
  const title = [fields.name, date].filter(Boolean).join(' — ') + ' — Leszy.run'
  const lead = [fields.name, fields.location, date].filter(Boolean).join(' — ')
  const description = truncate(
    fields.description ? `${lead}. ${fields.description}` : `${lead}. Zapisy, lista startowa i wyniki na żywo.`,
    300,
  )
  const url = `${SITE}/events/${slug}`
  const image = `${SITE}/api/event-og?slug=${slug}`

  const t = escapeAttr(title)
  const d = escapeAttr(description)
  const set = (html, pattern, value) => html.replace(pattern, (_, head) => `${head}${value}"`)

  let html = shell.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
  html = set(html, /(<meta name="description" content=")[^"]*"/, d)
  html = set(html, /(<meta name="robots" content=")[^"]*"/, fields.noindex ? 'noindex, follow' : 'index, follow')
  html = set(html, /(<link rel="canonical" href=")[^"]*"/, url)
  html = set(html, /(<meta property="og:title" content=")[^"]*"/, t)
  html = set(html, /(<meta property="og:description" content=")[^"]*"/, d)
  html = set(html, /(<meta property="og:url" content=")[^"]*"/, url)
  html = set(html, /(<meta property="og:image" content=")[^"]*"/, image)
  html = set(html, /(<meta property="og:image:alt" content=")[^"]*"/, t)
  html = set(html, /(<meta name="twitter:title" content=")[^"]*"/, t)
  html = set(html, /(<meta name="twitter:description" content=")[^"]*"/, d)
  html = set(html, /(<meta name="twitter:image" content=")[^"]*"/, image)
  return html
}

/** The preview fields for one slug, read with the anon key; null when nothing public has it. */
export async function readEventShareFields(client, slug) {
  const { data: registration, error } = await client.rpc('registration_public', { p_slug: slug })
  if (error) throw new Error(error.message)
  if (registration) return eventShareFields(registration, null)
  const { data: rows, error: evErr } = await client
    .from('events')
    .select('name, date, location, visibility')
    .eq('slug', slug)
    .limit(1)
  if (evErr) throw new Error(evErr.message)
  return eventShareFields(null, rows?.[0])
}
