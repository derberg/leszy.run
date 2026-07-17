import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const VOIVODESHIPS = new Set([
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
])

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const body = await req.json()
    const {
      username, display_name, nickname, avatar_url, bio, privacy_settings,
      gender, phone, date_of_birth, city, voivodeship, weekly_digest,
    } = body
    // club / club_id are intentionally NOT read — club identity is set only
    // through create-club / request-join / respond-join / manage-member.

    if (username !== undefined) {
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        return json({ error: 'Username must be 3–30 chars: lowercase letters, numbers, underscores only' }, 400, req)
      }
      const { data: taken } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', session.userId)
        .single()
      if (taken) return json({ error: 'Username already taken' }, 409, req)
    }

    if (gender !== undefined && gender !== null && !['M', 'F', 'X'].includes(gender)) {
      return json({ error: 'Płeć musi być jedną z: M, F, X' }, 400, req)
    }
    // Phone: store as E.164 (+48xxxxxxxxx). Accept user input that's "close enough"
    // (may include +48 already, spaces, dashes, parens) and normalize to E.164.
    let normalizedPhone
    if (phone !== undefined) {
      if (phone === null || phone === '') {
        normalizedPhone = null
      } else {
        let s = String(phone).replace(/[\s\-()]/g, '')
        if (s.startsWith('+48')) s = s.slice(3)
        else if (s.startsWith('0048')) s = s.slice(4)
        else if (s.startsWith('48') && s.length > 9) s = s.slice(2)
        s = s.replace(/\D/g, '')
        if (s.length !== 9) {
          return json({ error: 'Numer telefonu musi mieć 9 cyfr (numer polski +48)' }, 400, req)
        }
        normalizedPhone = `+48${s}`
      }
    }
    if (date_of_birth !== undefined && date_of_birth !== null && date_of_birth !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
        return json({ error: 'Data urodzenia musi być w formacie YYYY-MM-DD' }, 400, req)
      }
      const d = new Date(date_of_birth)
      const now = new Date()
      const minYear = 1900
      if (Number.isNaN(d.getTime()) || d > now || d.getFullYear() < minYear) {
        return json({ error: 'Data urodzenia poza dozwolonym zakresem' }, 400, req)
      }
    }
    if (city !== undefined && city !== null && city.length > 100) {
      return json({ error: 'Nazwa miejscowości za długa (max 100 znaków)' }, 400, req)
    }
    if (voivodeship !== undefined && voivodeship !== null && voivodeship !== '' && !VOIVODESHIPS.has(voivodeship)) {
      return json({ error: 'Nieprawidłowe województwo' }, 400, req)
    }
    if (weekly_digest !== undefined && typeof weekly_digest !== 'boolean') {
      return json({ error: 'weekly_digest musi być wartością logiczną' }, 400, req)
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, privacy_settings')
      .eq('id', session.userId)
      .single()

    const updates = {}
    if (username !== undefined)          updates.username = username
    if (display_name !== undefined)      updates.display_name = display_name
    if (avatar_url !== undefined)        updates.avatar_url = avatar_url
    if (bio !== undefined)               updates.bio = bio
    if (gender !== undefined)            updates.gender = gender || null
    if (phone !== undefined)             updates.phone = normalizedPhone
    if (date_of_birth !== undefined)     updates.date_of_birth = date_of_birth || null
    if (city !== undefined)              updates.city = city || null
    if (voivodeship !== undefined)       updates.voivodeship = voivodeship || null
    if (weekly_digest !== undefined)     updates.weekly_digest = weekly_digest

    if (body.nickname !== undefined) {
      if (body.nickname === null || body.nickname === '') {
        updates.nickname = null
      } else if (typeof body.nickname !== 'string' || body.nickname.trim().length > 60) {
        return json({ error: 'Pseudonim może mieć maksymalnie 60 znaków.' }, 400, req)
      } else {
        updates.nickname = body.nickname.trim()
      }
    }

    if (body.privacy_settings !== undefined) {
      const incoming = body.privacy_settings || {}
      const cpn = incoming.club_public_name
      if (cpn !== undefined && !['display', 'nickname'].includes(cpn)) {
        return json({ error: 'Nieprawidłowa wartość club_public_name.' }, 400, req)
      }
      updates.privacy_settings = { ...(existingProfile?.privacy_settings || {}), ...incoming }
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', session.userId)
      .select('*, clubs(name)')
      .single()
    if (error) throw error

    // API contract: keep returning club as a string
    const out = { ...profile, club: profile.clubs?.name ?? null }
    delete out.clubs

    return json({ data: out }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
