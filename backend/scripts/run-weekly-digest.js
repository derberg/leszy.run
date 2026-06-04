// Usage: cd backend && node --env-file=../.env scripts/run-weekly-digest.js [--apply]
//
// For every profile with weekly_digest=true, collects event_notifications from
// the last 7 days on their starred events (only notifications created AFTER the
// star) and sends one summary email via SendGrid. The 7-day deadline_soon
// window guarantees the weekly cadence always catches deadlines in time.
// Dry run by default (prints would-send summaries) — use --apply to send.
import { createClient } from '@supabase/supabase-js'

const dryRun = !process.argv.includes('--apply')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TYPE_LABELS = {
  cancelled: 'Bieg odwołany',
  registration_opened: 'Zapisy ruszyły',
  deadline_soon: 'Zostało mniej niż 7 dni do końca zapisów',
}

// Slugify duplicated from public/src/lib/slugify.js for Node compat
// (same established duplication as backend/scripts/publish-event-pages.js)
const POLISH_MAP = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
}
function slugify(name, date) {
  const base = (name || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => POLISH_MAP[ch] || ch)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${base}-${date}`
}

// SENDGRID_FROM_EMAIL may be '"Name" <email@x>' or a bare address
function parseFrom(raw) {
  const m = (raw || '').match(/^(.*)<([^>]+)>\s*$/)
  return m
    ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() }
    : { email: (raw || 'biuro@zatyrani.pl').trim() }
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: parseFrom(process.env.SENDGRID_FROM_EMAIL),
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  })
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`)
}

if (!dryRun && !process.env.SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY missing — cannot send. Aborting.')
  process.exit(1)
}

// 1. Opted-in users
const { data: users, error: usersErr } = await supabase
  .from('profiles')
  .select('id, email, username')
  .eq('weekly_digest', true)
  .is('deleted_at', null)
  .not('email', 'is', null)
if (usersErr) { console.error(usersErr.message); process.exit(1) }
if (!users?.length) { console.log('no digest subscribers — nothing to do'); process.exit(0) }

// 2. Their favorites (single query; paginate if this ever nears 1000 rows)
const { data: favs, error: favsErr } = await supabase
  .from('event_favorites')
  .select('user_id, event_id, created_at')
  .in('user_id', users.map((u) => u.id))
if (favsErr) { console.error(favsErr.message); process.exit(1) }

// 3. Notifications from the last 7 days on any of those events
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
const eventIds = [...new Set((favs ?? []).map((f) => f.event_id))]
let notifs = []
if (eventIds.length) {
  const { data, error: nErr } = await supabase
    .from('event_notifications')
    .select('event_id, type, created_at, calendar_events(name, date)')
    .gte('created_at', since)
    .in('event_id', eventIds)
  if (nErr) { console.error(nErr.message); process.exit(1) }
  notifs = data ?? []
}

// 4. Per-user digest: notification must postdate that user's star
const favsByUser = new Map()
for (const f of favs ?? []) {
  if (!favsByUser.has(f.user_id)) favsByUser.set(f.user_id, new Map())
  favsByUser.get(f.user_id).set(f.event_id, f.created_at)
}

let sent = 0
for (const user of users) {
  const myFavs = favsByUser.get(user.id)
  if (!myFavs) continue
  const mine = notifs.filter(
    (n) => myFavs.has(n.event_id) && new Date(n.created_at) > new Date(myFavs.get(n.event_id))
  )
  if (!mine.length) continue

  const items = mine
    .map((n) => {
      const name = n.calendar_events?.name ?? 'Wydarzenie'
      const url = `https://www.leszy.run/kalendarz/${slugify(name, n.calendar_events?.date)}`
      return `<li><strong>${TYPE_LABELS[n.type]}</strong> — <a href="${url}">${name}</a></li>`
    })
    .join('\n')
  const html = `
    <p>Cześć${user.username ? ` ${user.username}` : ''}!</p>
    <p>W obserwowanych przez Ciebie biegach w ostatnim tygodniu:</p>
    <ul>${items}</ul>
    <p><a href="https://www.leszy.run/profil">Zarządzaj obserwowanymi i powiadomieniami</a></p>
    <p style="color:#888;font-size:12px">Dostajesz tę wiadomość, bo masz włączone cotygodniowe
    podsumowanie na leszy.run. Możesz je wyłączyć w swoim profilu.</p>`

  if (dryRun) {
    console.log(`WOULD SEND to ${user.email}: ${mine.length} item(s)`)
    for (const n of mine) console.log(`   - [${n.type}] ${n.calendar_events?.name}`)
  } else {
    await sendEmail(user.email, 'Leszy.run — co nowego w obserwowanych biegach', html)
    sent++
  }
}

console.log(dryRun ? '\nDRY RUN — no emails sent. Use --apply to send.' : `sent ${sent} digest(s)`)
