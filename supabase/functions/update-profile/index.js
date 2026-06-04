import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndAwardBadges } from '../_shared/badge-check.js'
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
      username, display_name, club, club_id, avatar_url, bio, privacy_settings,
      gender, phone, date_of_birth, city, voivodeship, weekly_digest,
    } = body

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
      .select('id, club_id')
      .eq('id', session.userId)
      .single()

    const updates = {}
    if (username !== undefined)          updates.username = username
    if (display_name !== undefined)      updates.display_name = display_name
    if (avatar_url !== undefined)        updates.avatar_url = avatar_url
    if (bio !== undefined)               updates.bio = bio
    if (privacy_settings !== undefined)  updates.privacy_settings = privacy_settings
    if (gender !== undefined)            updates.gender = gender || null
    if (phone !== undefined)             updates.phone = normalizedPhone
    if (date_of_birth !== undefined)     updates.date_of_birth = date_of_birth || null
    if (city !== undefined)              updates.city = city || null
    if (voivodeship !== undefined)       updates.voivodeship = voivodeship || null
    if (weekly_digest !== undefined)     updates.weekly_digest = weekly_digest

    // Club: a picked club_id takes precedence over free-text club.
    if (club_id !== undefined && club_id !== null && club_id !== '') {
      const { data: clubRow, error: clubLookupErr } = await supabaseAdmin
        .from('clubs').select('id').eq('id', club_id).single()
      if (clubLookupErr && clubLookupErr.code !== 'PGRST116') throw clubLookupErr
      if (!clubRow) return json({ error: 'Unknown club_id' }, 400, req)
      updates.club_id = club_id
    } else if (club !== undefined) {
      if (club === null || club.trim() === '') {
        updates.club_id = null
      } else {
        if (club.length > 100) return json({ error: 'Club name too long (max 100 chars)' }, 400, req)
        const { data: newClubId, error: clubErr } = await supabaseAdmin
          .rpc('find_or_create_club', { club_name: club })
        if (clubErr) throw clubErr
        if (!newClubId) return json({ error: 'Invalid club name' }, 400, req)
        updates.club_id = newClubId
      }
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', session.userId)
      .select('*, clubs(name)')
      .single()
    if (error) throw error

    const clubJustSet = updates.club_id != null && !existingProfile?.club_id
    if (clubJustSet) {
      await checkAndAwardBadges(supabaseAdmin, session.userId)
    }

    // API contract: keep returning club as a string
    const out = { ...profile, club: profile.clubs?.name ?? null }
    delete out.clubs

    return json({ data: out }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
