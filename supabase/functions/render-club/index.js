// supabase/functions/render-club/index.js
// PUBLIC SSR page for /klub/:slug (Vercel rewrite → this function, ?slug=<slug>).
// No session / auth — this is served to anonymous visitors and crawlers.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

function html(body, status, req) {
  // Build headers via a Headers instance and set Content-Type explicitly last —
  // a plain-object spread was coming back as text/plain on the deployed runtime,
  // which breaks HTML/JSON-LD parsing for crawlers.
  const headers = new Headers(getCorsHeaders(req))
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  return new Response(body, { status, headers })
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function notFoundPage(req) {
  const doc = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Nie znaleziono klubu — leszy.run</title>
<meta name="robots" content="noindex">
</head>
<body>
<h1>Nie znaleziono klubu</h1>
<p>Ten klub nie istnieje albo nie jest publiczny.</p>
</body>
</html>`
  return html(doc, 404, req)
}

function errorPage(req) {
  const doc = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Błąd — leszy.run</title>
<meta name="robots" content="noindex">
</head>
<body>
<h1>Coś poszło nie tak</h1>
<p>Spróbuj ponownie później.</p>
</body>
</html>`
  return html(doc, 500, req)
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const slug = new URL(req.url).searchParams.get('slug')
  if (!slug) return notFoundPage(req)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { data: club } = await supabaseAdmin
      .from('clubs')
      .select('id, name, slug, description, city, voivodeship, logo_url, is_public, created_at')
      .eq('slug', slug).eq('is_public', true).maybeSingle()
    if (!club) return notFoundPage(req)

    const { data: memberRows } = await supabaseAdmin
      .from('club_members')
      .select('user_id, hidden_public, profiles(display_name, nickname, privacy_settings)')
      .eq('club_id', club.id).eq('status', 'active')

    const allMembers = memberRows ?? []
    const memberCount = allMembers.length

    // Public roster: hidden_public members are omitted entirely; visible ones
    // are labeled by nickname when the member opted into
    // privacy_settings.club_public_name === 'nickname', else display_name.
    const visibleLabels = allMembers
      .filter((m) => !m.hidden_public)
      .map((m) => {
        const wantsNickname = m.profiles?.privacy_settings?.club_public_name === 'nickname'
        const primary = wantsNickname ? m.profiles?.nickname : m.profiles?.display_name
        return primary || m.profiles?.nickname || m.profiles?.display_name || 'Anonimowy zawodnik'
      })

    // Upcoming clubmate-followed events — same aggregation as get-club, but
    // public visitors only see a small teaser (cap ~10), never the full list.
    const visibleIds = allMembers
      .filter((m) => (m.profiles?.privacy_settings?.favorites ?? true) !== false)
      .map((m) => m.user_id)

    let events = []
    if (visibleIds.length) {
      const today = new Date().toISOString().slice(0, 10)
      const eventsById = {}
      const pageSize = 1000
      for (let from = 0; ; from += pageSize) {
        const { data: favs } = await supabaseAdmin
          .from('event_favorites')
          .select('event_id, calendar_events(id, name, date, location, status)')
          .in('user_id', visibleIds)
          .order('event_id')
          .range(from, from + pageSize - 1)
        for (const f of favs ?? []) {
          const ev = f.calendar_events
          if (!ev || !['active', 'cancelled'].includes(ev.status)) continue
          if (ev.date && ev.date < today) continue
          if (!eventsById[ev.id]) eventsById[ev.id] = { event: ev, count: 0 }
          eventsById[ev.id].count += 1
        }
        if (!favs || favs.length < pageSize) break
      }
      events = Object.values(eventsById)
        .sort((a, b) => (a.event.date || '').localeCompare(b.event.date || ''))
        .slice(0, 10)
    }

    const canonicalUrl = `https://www.leszy.run/klub/${esc(club.slug)}`
    const description = club.description
      ? club.description.slice(0, 200)
      : `${club.name} — klub biegowy na leszy.run${club.city ? ` (${club.city})` : ''}.`

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'SportsTeam',
      name: club.name,
      url: canonicalUrl,
      ...(club.logo_url ? { logo: club.logo_url } : {}),
      ...(club.description ? { description: club.description } : {}),
      ...(club.city ? { location: { '@type': 'Place', name: club.city } } : {}),
    }

    const memberListHtml = visibleLabels.length
      ? `<ul>${visibleLabels.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
      : '<p>Brak publicznie widocznych członków.</p>'

    const eventsHtml = events.length
      ? `<h2>Wydarzenia śledzone przez klub</h2><ul>${events
          .map((e) => `<li>${esc(e.event.name)} — ${esc(e.event.date)} (${e.count})</li>`)
          .join('')}</ul>`
      : ''

    const doc = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(club.name)} — klub biegowy | leszy.run</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonicalUrl}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(club.name)} — klub biegowy | leszy.run">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonicalUrl}">
${club.logo_url ? `<meta property="og:image" content="${esc(club.logo_url)}">` : ''}
<meta name="twitter:card" content="${club.logo_url ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(club.name)} — klub biegowy | leszy.run">
<meta name="twitter:description" content="${esc(description)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<h1>${esc(club.name)}</h1>
${club.logo_url ? `<img src="${esc(club.logo_url)}" alt="${esc(club.name)}" width="128" height="128">` : ''}
${club.description ? `<p>${esc(club.description)}</p>` : ''}
${club.city ? `<p>${esc(club.city)}${club.voivodeship ? `, ${esc(club.voivodeship)}` : ''}</p>` : ''}
<p>Liczba członków: ${memberCount}</p>
<h2>Członkowie</h2>
${memberListHtml}
${eventsHtml}
</body>
</html>`

    return html(doc, 200, req)
  } catch (err) {
    console.error('render-club error:', err)
    return errorPage(req)
  }
})
