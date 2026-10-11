// Usage: cd backend && node --env-file=../.env scripts/run-weekly-digest.js [--apply]
//
// For every profile with weekly_digest=true, collects event_notifications from
// the last 7 days on their starred events (only notifications created AFTER the
// star) and sends one summary email via SendGrid. The 7-day deadline_soon
// window guarantees the weekly cadence always catches deadlines in time.
// Dry run by default (prints would-send summaries) — use --apply to send.
import { createClient } from '@supabase/supabase-js'

const dryRun = !process.argv.includes('--apply')

import { pickDigestNotifications } from './lib/notificationWindow.js'
// The same rule the in-app feed uses, so the email and the badge cannot
// disagree about what the user was told (supabase/functions/_shared is plain
// JS — no Deno globals — so Node can import it directly).
import { deadlineSoonFor } from '../../supabase/functions/_shared/deadlineSoon.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TYPE_LABELS = {
  registration_opened: 'Zapisy ruszyły',
  deadline_soon: 'Zostało mniej niż 7 dni do końca zapisów',
}

// Accent color per notification type — a left stripe on each row. On-brand
// acid-yellow for "good news", amber for deadlines.
const TYPE_ACCENT = {
  registration_opened: '#BBDD00',
  deadline_soon: '#F59E0B',
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
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

// PostgREST caps responses at 1000 rows — paginate or silently lose data.
async function fetchAll(buildQuery) {
  const pageSize = 1000
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) { console.error(error.message); process.exit(1) }
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) break
  }
  return rows
}

if (!dryRun && !process.env.SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY missing — cannot send. Aborting.')
  process.exit(1)
}

// 1. Opted-in users (digest subscribers won't near 1000 soon; .order for determinism)
const { data: users, error: usersErr } = await supabase
  .from('profiles')
  .select('id, email, username, digest_sent_at')
  .eq('weekly_digest', true)
  .is('deleted_at', null)
  .not('email', 'is', null)
  .order('id')
if (usersErr) { console.error(usersErr.message); process.exit(1) }
if (!users?.length) { console.log('no digest subscribers — nothing to do'); process.exit(0) }

// 2. Their favorites — paginate past PostgREST 1000-row cap
const favs = await fetchAll(() =>
  supabase
    .from('event_favorites')
    .select('user_id, event_id, created_at')
    .in('user_id', users.map((u) => u.id))
    .order('created_at')
)

// 3. Notifications from the last 7 days on any of those events — paginate past cap
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
const since = sevenDaysAgo
const todayIso = new Date().toISOString().slice(0, 10)
const eventIds = [...new Set(favs.map((f) => f.event_id))]
let notifs = []
if (eventIds.length) {
  notifs = await fetchAll(() =>
    supabase
      .from('event_notifications')
      .select('event_id, type, created_at, calendar_events(name, date, status)')
      .eq('type', 'registration_opened')
      .gte('created_at', since)
      .in('event_id', eventIds)
      .order('created_at')
  )

  // deadline_soon is derived, not read: a stored row fires once per event
  // (UNIQUE(event_id,type)), and every reader drops notifications older than
  // the user's star — so anyone who starred a race after that single row was
  // written could never be warned its entries were closing.
  const favEvents = await fetchAll(() =>
    supabase
      .from('calendar_events')
      .select('id, name, date, status, registration_deadline')
      .in('id', eventIds)
      .order('id')
  )
  for (const ev of favEvents) {
    const hit = deadlineSoonFor(ev, todayIso)
    if (hit) notifs.push({ ...hit, calendar_events: ev })
  }
}

// 4. Per-user digest: notification must postdate that user's star
const favsByUser = new Map()
for (const f of favs) {
  if (!favsByUser.has(f.user_id)) favsByUser.set(f.user_id, new Map())
  favsByUser.get(f.user_id).set(f.event_id, f.created_at)
}

let sent = 0
let failed = 0
for (const user of users) {
  const myFavs = favsByUser.get(user.id)
  if (!myFavs) continue
  // Never before this user's last successful digest: the 7-day window alone
  // meant that re-running the job after a partial failure mailed everyone who
  // had already been served the same week a second time.
  const since = user.digest_sent_at && user.digest_sent_at > sevenDaysAgo ? user.digest_sent_at : sevenDaysAgo
  const mine = pickDigestNotifications(notifs, myFavs, since, todayIso)
  if (!mine.length) continue

  const items = mine
    .map((n) => {
      const name = n.calendar_events?.name ?? 'Wydarzenie'
      const url = `https://www.leszy.run/kalendarz/${slugify(name, n.calendar_events?.date)}`
      const accent = TYPE_ACCENT[n.type] || '#BBDD00'
      return `
              <tr>
                <td style="padding:0 0 12px 0;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:#ffffff;border:1px solid #e5e5ea;border-left:3px solid ${accent};">
                    <tr>
                      <td style="padding:14px 18px;">
                        <p style="margin:0 0 6px 0;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#8886a0;">${TYPE_LABELS[n.type]}</p>
                        <a href="${url}" style="font-size:16px;font-weight:800;line-height:1.3;color:#1a1a28;text-decoration:none;letter-spacing:-0.01em;">${escapeHtml(name)}</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`
    })
    .join('\n')
  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Co nowego w obserwowanych biegach</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #e5e5ea;">
          <tr>
            <td align="center" style="padding:0;">
              <a href="https://www.leszy.run" style="text-decoration:none;display:block;">
                <img src="https://www.leszy.run/og-image.png" alt="Leszy.run" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;"/>
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#8886a0;">Podsumowanie tygodnia</p>
              <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;line-height:1.3;color:#1a1a28;letter-spacing:-0.01em;">
                Cześć${user.username ? ` ${escapeHtml(user.username)}` : ''}! Co nowego w Twoich biegach
              </h1>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#525266;">
                W obserwowanych przez Ciebie biegach w ostatnim tygodniu wydarzyło się to:
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
                ${items}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background:#BBDD00;">
                    <a href="https://www.leszy.run/profil" style="display:inline-block;padding:14px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0A0A10;text-decoration:none;">
                      Zarządzaj obserwowanymi
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 32px 32px;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#8886a0;border-top:1px solid #e5e5ea;padding-top:16px;">
                Dostajesz tę wiadomość, bo masz włączone cotygodniowe podsumowanie na leszy.run.
                Możesz je wyłączyć w <a href="https://www.leszy.run/profil" style="color:#525266;">swoim profilu</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 24px 32px;">
              <p style="margin:0;font-size:11px;line-height:1.5;color:#8886a0;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">
                <a href="https://www.leszy.run" style="color:#8886a0;text-decoration:none;">Leszy.run</a>
                <span style="color:#cccccc;">&nbsp;·&nbsp;</span>
                <span>Kalendarz biegów w Polsce</span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  if (dryRun) {
    console.log(`WOULD SEND to ${user.email}: ${mine.length} item(s)`)
    for (const n of mine) console.log(`   - [${n.type}] ${n.calendar_events?.name}`)
  } else {
    try {
      await sendEmail(user.email, 'Leszy.run — co nowego w obserwowanych biegach', html)
      sent++
      // Stamped only after SendGrid accepted it, so a failure re-sends next run
      // rather than swallowing the week.
      const { error: stampErr } = await supabase
        .from('profiles')
        .update({ digest_sent_at: new Date().toISOString() })
        .eq('id', user.id)
      if (stampErr) console.error(`digest_sent_at stamp failed for ${user.email}: ${stampErr.message}`)
    } catch (err) {
      console.error(`send failed for ${user.email}: ${err.message}`)
      failed++
    }
  }
}

console.log(dryRun
  ? '\nDRY RUN — no emails sent. Use --apply to send.'
  : `sent ${sent} digest(s), failed ${failed}`)
if (!dryRun) process.exit(failed > 0 ? 1 : 0)
