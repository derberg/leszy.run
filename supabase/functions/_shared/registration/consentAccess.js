// The consent page's server side (Plan 4): what consent-request and accept-consent share.
// A link token is looked up by its SHA-256 only (tokens.js). The raw token never reaches a log,
// a response or a throttle key (the key carries the hash), and the registration's address
// appears in a response only after the person proved it (session or e-mail code). Logs name
// registrations by id, never by address.
import { checkAndIncrement } from '../throttle.js'
import { clientIp } from '../clientIp.js'
import { hashToken } from './tokens.js'
import { json } from './registrationRequest.js'

// 32 random bytes in base64url (tokens.js).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HOUR = 3600

export const GONE_LINK = 'Ten link został już użyty albo wygasł.'
export const GONE_ENTRY = 'To zgłoszenie nie jest już aktywne.'
export const TOO_MANY = 'Zbyt wiele prób. Spróbuj ponownie później.'
export const WRONG_SESSION = 'Zaloguj się adresem e-mail, na który przyszedł link.'
export const EDITS_CLOSED = 'Po zamknięciu zapisów dane poprawisz w biurze zawodów.'

/**
 * p***@g***.com: the first character of the local part, the first character of the domain and
 * its last label (the TLD). A one-character local part shows nothing of it (`*@x***.pl`), so the
 * hint never spells out a whole address; a personal or company domain stays hidden too (m3).
 */
export function emailHint(email) {
  const s = String(email ?? '')
  const at = s.lastIndexOf('@')
  const local = at >= 0 ? s.slice(0, at) : s
  const domain = at >= 0 ? s.slice(at + 1) : ''
  const head = local.length > 1 ? `${local.slice(0, 1)}***` : '*'
  const dot = domain.lastIndexOf('.')
  const tail = !domain ? '*'
    : dot > 0 ? `${domain.slice(0, 1)}***${domain.slice(dot)}`
      : `${domain.slice(0, 1)}***`
  return `${head}@${tail}`
}

/**
 * consent-token:<hash>, per hour, shared by consent-request and accept-consent. 30, not 10 (m4):
 * one ordinary visit (page load, sendCode, a mistyped code, the code, a correction or two,
 * accept, a reload) used most of 10.
 */
export const TOKEN_LIMIT = 30

/** The hash of whatever the client sent as the token (a non-string hashes as ''). */
export const tokenHash = (token) => hashToken(typeof token === 'string' ? token : '')

/**
 * Claims the given throttles in order: [{ key, limit }], per hour, fail open (a broken limiter
 * must not lock the page; the 256-bit token is what stops guessing). → a 429 Response or null.
 */
export async function throttled(admin, req, limits) {
  for (const { key, limit } of limits) {
    const t = await checkAndIncrement(admin, key, limit, { failOpen: true, windowSeconds: HOUR })
    if (!t.allowed) return json({ error: TOO_MANY, code: 'throttled' }, 429, req, { 'retry-after': String(t.retryAfterSec) })
  }
  return null
}

export const ipKey = (req) => {
  const ip = clientIp(req)
  return ip ? `consent-ip:${ip}` : null
}

/**
 * The request and its registration for a token. → { request, registration } or { response }:
 * 410 invalid (unknown, malformed or rotated), used, expired; 409 gone (the entry was cancelled
 * or its order refunded). `strict: false` skips the used, expiry and status checks
 * (accept-consent lets the RPC decide those under its locks).
 */
export async function loadByToken(admin, req, token, hash, { strict = true } = {}) {
  const gone = (code) => ({ response: json({ error: GONE_LINK, code }, 410, req) })
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return gone('invalid')
  const { data: request, error } = await admin.from('consent_requests')
    .select('registration_id, used_at, expires_at').eq('token_hash', hash).maybeSingle()
  if (error) throw error
  if (!request) return gone('invalid')
  const { data: registration, error: rErr } = await admin.from('registrations')
    .select('*').eq('id', request.registration_id).maybeSingle()
  if (rErr) throw rErr
  if (!registration) return gone('invalid')
  if (strict) {
    if (request.used_at || registration.consent_state !== 'awaiting') return gone('used')
    if (Date.parse(request.expires_at) <= Date.now()) return gone('expired')
    if (registration.status !== 'confirmed') return { response: json({ error: GONE_ENTRY, code: 'gone' }, 409, req) }
  }
  return { request, registration }
}

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

/** The event settings, the competition and validatePerson's context for a registration. */
export async function personContext(admin, registration) {
  const [settingsRows, comps, ageGroups, kidsGroups] = await Promise.all([
    rows(admin.from('registration_settings').select('*').eq('event_id', registration.event_id)),
    rows(admin.from('competitions').select('*').eq('category_id', registration.category_id)),
    rows(admin.from('age_groups').select('gender, label, min_age, max_age').eq('category_id', registration.category_id)),
    rows(admin.from('kids_groups').select('id, gender, birth_year_from, birth_year_to').eq('category_id', registration.category_id)),
  ])
  const settings = settingsRows[0]
  const competition = comps[0]
  if (!settings || !competition) throw new Error('registration without settings or competition')
  return {
    settings,
    competition,
    ctx: {
      formFields: settings.form_fields ?? {},
      competition: { minAge: competition.min_age, maxAge: competition.max_age, isKids: competition.is_kids },
      raceDate: settings.event_date,
      reckoning: settings.age_reckoning,
      ageGroups: ageGroups.map((g) => ({ gender: g.gender, label: g.label, minAge: g.min_age, maxAge: g.max_age })),
      kidsGroups: kidsGroups.map((g) => ({ id: g.id, gender: g.gender, minYear: g.birth_year_from, maxYear: g.birth_year_to })),
    },
  }
}

/** The person as the consent page shows and edits them. */
export const personOf = (r) => ({
  firstName: r.first_name, lastName: r.last_name, birthDate: r.birth_date, gender: r.gender, email: r.email,
  phone: r.phone, city: r.city, club: r.club, iceName: r.ice_name, icePhone: r.ice_phone, nationality: r.nationality,
})

/** Who may act on a link: a session whose address is the registration's. */
export const sessionMatches = (session, registration) =>
  Boolean(session?.email && registration?.email && session.email.trim().toLowerCase() === registration.email.trim().toLowerCase())
