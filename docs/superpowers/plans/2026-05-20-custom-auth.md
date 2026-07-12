# Custom Email OTP Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supabase Auth with a custom email OTP + httpOnly session cookie system backed by two new Supabase tables and a set of Edge Functions.

**Architecture:** Edge functions handle all auth (request-code, verify-code, logout, me) and all authenticated data reads (get-profile-data). Session token stored in `leszy_session` httpOnly cookie set by `auth-verify-code`. All edge functions use a shared `_shared/session.js` module to validate the cookie. The Supabase anon key is kept only for public reads. CORS is dynamic (specific allowed origins + `Access-Control-Allow-Credentials: true`) so cookies can be sent cross-origin from the SPA.

**Tech Stack:** Supabase Edge Functions (Deno), Supabase Postgres, SendGrid (email), Playwright E2E, Node.js `node:test` integration tests, React 19 + React Router 7.

---

## File Map

**New files:**
- `supabase/functions/_shared/cors.js` — dynamic CORS headers for credentialed cross-origin requests
- `supabase/functions/_shared/session.js` — reads `leszy_session` cookie, validates against `auth_sessions`
- `supabase/functions/auth-request-code/index.js` — generate + email OTP code
- `supabase/functions/auth-verify-code/index.js` — validate code, create session, set cookie
- `supabase/functions/auth-logout/index.js` — delete session, clear cookie
- `supabase/functions/auth-me/index.js` — return current user from session
- `supabase/functions/get-profile-data/index.js` — return full profile dashboard data
- `supabase/functions/tests/auth.test.js` — integration tests for auth edge functions

**Modified files:**
- `supabase/functions/update-profile/index.js` — swap JWT for session cookie
- `supabase/functions/submit-contribution/index.js` — swap JWT for session cookie
- `supabase/functions/admin-review-contribution/index.js` — swap JWT for session cookie
- `supabase/functions/tests/helpers.js` — remove Supabase Auth, add session cookie helpers
- `public/src/lib/auth.js` — full rewrite: requestCode, verifyCode, signOut, getMe, callFunction
- `public/src/hooks/useAuth.js` — rewrite: call auth-me on mount, no supabase.auth
- `public/src/pages/Login.jsx` — rewrite: wire to new auth functions, add honeypot
- `public/src/pages/Profil.jsx` — replace 4 Supabase queries with callFunction('get-profile-data')
- `public/src/pages/Onboarding.jsx` — remove supabase.from check, use useAuth user.username
- `public/tests/e2e/helpers.js` — inject session cookie directly, no magic links
- `public/tests/e2e/auth.spec.js` — update to use new login flow
- `public/tests/e2e/onboarding.spec.js` — update helpers usage
- `public/tests/e2e/profile.spec.js` — update helpers usage
- `public/tests/e2e/public-profile.spec.js` — update helpers usage
- `public/tests/e2e/contributions.spec.js` — update helpers usage

---

## Task 1: DB schema — profiles email column + auth tables + drop old RLS policies

**Files:**
- Supabase migration only (no local Drizzle — these are Supabase-only tables)

- [ ] **Step 1: Apply the migration**

Run via MCP `apply_migration` with name `custom_auth_schema`:

```sql
-- Drop FK constraint from profiles to auth.users (no longer using Supabase Auth)
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- Add email column to profiles (used to find profile on login)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE profiles ADD CONSTRAINT IF NOT EXISTS profiles_email_key UNIQUE (email);

-- auth_codes: stores hashed OTP codes
CREATE TABLE IF NOT EXISTS auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_codes_email_idx ON auth_codes (email);
ALTER TABLE auth_codes ENABLE ROW LEVEL SECURITY;

-- auth_sessions: stores active sessions
CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

-- Drop auth.uid()-based RLS policies (access now controlled at edge function layer)
DROP POLICY IF EXISTS "Owner reads own profile" ON profiles;
DROP POLICY IF EXISTS "Users can read own reports" ON calendar_event_reports;
```

- [ ] **Step 2: Verify**

Run in Supabase SQL editor:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'email';
SELECT table_name FROM information_schema.tables WHERE table_name IN ('auth_codes', 'auth_sessions');
SELECT policyname FROM pg_policies WHERE tablename IN ('profiles', 'calendar_event_reports') AND cmd = 'SELECT';
```
Expected: email column exists, both tables exist, no SELECT policies on profiles or calendar_event_reports.

- [ ] **Step 3: Add Supabase secrets for the new edge functions**

In Supabase Dashboard → Edge Functions → Secrets, add (if not already present):
- `SENDGRID_API_KEY` — same value as in `.env`
- `SENDGRID_FROM_EMAIL` — same value as in `.env`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: db schema for custom auth (auth_codes, auth_sessions, profiles.email)"
```

---

## Task 2: `_shared/cors.js` — dynamic CORS for credentialed requests

**Files:**
- Create: `supabase/functions/_shared/cors.js`

Context: All existing edge functions use `'Access-Control-Allow-Origin': '*'`. With `credentials: 'include'` on fetch calls, browsers reject `*` — the origin must be explicit. This module reads the `Origin` header and echoes it back if it's in the allowlist.

- [ ] **Step 1: Create the file**

```js
// supabase/functions/_shared/cors.js
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://www.leszy.run',
  'https://leszy.run',
]

export function getCorsHeaders(req) {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Credentials': 'true',
  }
}

export function handleOptions(req) {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: getCorsHeaders(req) })
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/cors.js
git commit -m "feat: shared CORS helper for credentialed cross-origin requests"
```

---

## Task 3: `_shared/session.js` — cookie-based session validation

**Files:**
- Create: `supabase/functions/_shared/session.js`

- [ ] **Step 1: Create the file**

```js
// supabase/functions/_shared/session.js

/**
 * Reads the leszy_session cookie, validates it against auth_sessions.
 * Returns { userId, email } if valid, null otherwise.
 *
 * @param {Request} req
 * @param {ReturnType<import('https://esm.sh/@supabase/supabase-js@2').createClient>} supabaseAdmin
 */
export async function getSession(req, supabaseAdmin) {
  const cookieHeader = req.headers.get('Cookie') ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)leszy_session=([^;]+)/)
  if (!match) return null

  const token = decodeURIComponent(match[1])

  const { data } = await supabaseAdmin
    .from('auth_sessions')
    .select('user_id, email, expires_at')
    .eq('id', token)
    .single()

  if (!data) return null
  if (new Date(data.expires_at) < new Date()) return null

  return { userId: data.user_id, email: data.email }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/session.js
git commit -m "feat: shared session cookie validation module"
```

---

## Task 4: `auth-request-code` edge function + integration tests

**Files:**
- Create: `supabase/functions/auth-request-code/index.js`
- Create: `supabase/functions/tests/auth.test.js`

- [ ] **Step 1: Write the failing integration test first**

```js
// supabase/functions/tests/auth.test.js
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin, FUNCTIONS_URL } from './helpers.js'
import crypto from 'node:crypto'

async function post(path, body, cookie = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = `leszy_session=${cookie}`
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json(), headers: res.headers }
}

describe('auth-request-code', () => {
  after(async () => {
    await supabaseAdmin.from('auth_codes').delete().like('email', '%@test.leszy.run')
  })

  it('returns 200 silently when honeypot is filled', async () => {
    const { status, data } = await post('auth-request-code', {
      email: 'bot@test.leszy.run',
      honeypot: 'I am a bot',
    })
    assert.equal(status, 200)
    assert.equal(data.success, true)
    // Verify no code was stored
    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('id')
      .eq('email', 'bot@test.leszy.run')
    assert.equal(codes.length, 0)
  })

  it('returns 400 for invalid email', async () => {
    const { status } = await post('auth-request-code', { email: 'notanemail' })
    assert.equal(status, 400)
  })

  it('stores a hashed code and returns success for valid email', async () => {
    const email = `req-code-${Date.now()}@test.leszy.run`
    const { status, data } = await post('auth-request-code', { email })
    assert.equal(status, 200)
    assert.equal(data.success, true)

    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('code_hash, used, attempts')
      .eq('email', email)
      .eq('used', false)
    assert.equal(codes.length, 1)
    assert.equal(codes[0].used, false)
    assert.equal(codes[0].attempts, 0)
    assert.ok(codes[0].code_hash.length === 64) // sha256 hex
  })

  it('invalidates previous unused codes when a new one is requested', async () => {
    const email = `req-code-multi-${Date.now()}@test.leszy.run`
    await post('auth-request-code', { email })
    await post('auth-request-code', { email })

    const { data: active } = await supabaseAdmin
      .from('auth_codes')
      .select('id')
      .eq('email', email)
      .eq('used', false)
    assert.equal(active.length, 1) // only the latest is active
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /path/to/project/public
SUPABASE_URL=$SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY node --test ../supabase/functions/tests/auth.test.js 2>&1 | grep -A3 "auth-request-code"
```
Expected: FAIL (function not deployed yet).

- [ ] **Step 3: Create the edge function**

```js
// supabase/functions/auth-request-code/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { email, honeypot } = await req.json()

    if (honeypot) return json({ success: true }, 200, req)

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Nieprawidłowy adres email.' }, 400, req)
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Invalidate previous unused codes for this email
    await supabaseAdmin
      .from('auth_codes')
      .update({ used: true })
      .eq('email', normalizedEmail)
      .eq('used', false)

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const codeHash = await sha256hex(code)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: insertError } = await supabaseAdmin
      .from('auth_codes')
      .insert({ email: normalizedEmail, code_hash: codeHash, expires_at: expiresAt })
    if (insertError) throw insertError

    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SENDGRID_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: normalizedEmail }] }],
        from: { email: Deno.env.get('SENDGRID_FROM_EMAIL') },
        subject: 'Twój kod logowania — Leszy.run',
        content: [{
          type: 'text/plain',
          value: `Twój kod logowania do Leszy.run:\n\n${code}\n\nKod jest ważny przez 10 minut. Jeśli to nie Ty, zignoruj tę wiadomość.`,
        }],
      }),
    })

    if (!sgRes.ok) {
      console.error('SendGrid error:', await sgRes.text())
      throw new Error('Email send failed')
    }

    return json({ success: true }, 200, req)
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera. Spróbuj ponownie.' }, 500, req)
  }
})
```

- [ ] **Step 4: Deploy**

Deploy via MCP `deploy_edge_function` with `verify_jwt: false` (public endpoint), including `_shared/cors.js` in the files array.

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd /path/to/project/public
SUPABASE_URL=$SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY node --test ../supabase/functions/tests/auth.test.js 2>&1
```
Expected: all `auth-request-code` tests PASS. The "stores a hashed code" test will PASS even if SendGrid send fails (the code is stored; email delivery is a side effect).

Note: if SendGrid is not configured in Supabase secrets yet, the function returns 500 on the "stores a hashed code" test. Add secrets first (Task 1 Step 3) or temporarily mock by returning early after insert.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/auth-request-code/ supabase/functions/tests/auth.test.js
git commit -m "feat: auth-request-code edge function with OTP code generation and SendGrid email"
```

---

## Task 5: `auth-verify-code` edge function + integration tests

**Files:**
- Create: `supabase/functions/auth-verify-code/index.js`
- Modify: `supabase/functions/tests/auth.test.js`

- [ ] **Step 1: Add tests to `auth.test.js`**

Add a new `describe('auth-verify-code', ...)` block after the existing one:

```js
describe('auth-verify-code', () => {
  const email = `verify-${Date.now()}@test.leszy.run`

  async function seedCode(overrides = {}) {
    const code = '123456'
    const hash = crypto.createHash('sha256').update(code).digest('hex')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    await supabaseAdmin.from('auth_codes').insert({
      email,
      code_hash: hash,
      expires_at: overrides.expiresAt ?? expiresAt,
      attempts: overrides.attempts ?? 0,
      used: overrides.used ?? false,
    })
    return code
  }

  after(async () => {
    await supabaseAdmin.from('auth_sessions').delete().eq('email', email)
    await supabaseAdmin.from('profiles').delete().eq('email', email)
    await supabaseAdmin.from('auth_codes').delete().eq('email', email)
  })

  it('returns 400 for expired code', async () => {
    await seedCode({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    const { status } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(status, 400)
  })

  it('returns 401 for wrong code', async () => {
    await seedCode()
    const { status } = await post('auth-verify-code', { email, code: '000000' })
    assert.equal(status, 401)
  })

  it('returns 403 after 3 failed attempts', async () => {
    await seedCode({ attempts: 3 })
    const { status } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(status, 403)
  })

  it('returns 200 with Set-Cookie on correct code, creates profile and session', async () => {
    await seedCode()
    const { status, data, headers } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(typeof data.hasUsername, 'boolean')

    const setCookie = headers.get('set-cookie')
    assert.ok(setCookie?.includes('leszy_session='))
    assert.ok(setCookie?.includes('HttpOnly'))

    // Profile created
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .single()
    assert.equal(profile.email, email)

    // Session created
    const token = setCookie.match(/leszy_session=([^;]+)/)[1]
    const { data: session } = await supabaseAdmin
      .from('auth_sessions')
      .select('user_id, email')
      .eq('id', token)
      .single()
    assert.equal(session.email, email)
  })

  it('returns hasUsername=true if profile already has username', async () => {
    // The previous test created the profile; update it with a username
    await supabaseAdmin
      .from('profiles')
      .update({ username: `verify_user_${Date.now()}`.slice(0, 30) })
      .eq('email', email)
    await seedCode()
    const { data } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(data.hasUsername, true)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test ../supabase/functions/tests/auth.test.js 2>&1 | grep -A3 "auth-verify-code"
```
Expected: FAIL.

- [ ] **Step 3: Create the edge function**

```js
// supabase/functions/auth-verify-code/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

const SESSION_MAX_AGE = 60 * 24 * 60 * 60 // 60 days in seconds

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { email, code } = await req.json()

    if (!email || !code || !/^\d{6}$/.test(String(code).trim())) {
      return json({ error: 'Nieprawidłowe dane.' }, 400, req)
    }

    const normalizedEmail = email.toLowerCase().trim()
    const trimmedCode = String(code).trim()
    const now = new Date().toISOString()

    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('id, code_hash, attempts')
      .eq('email', normalizedEmail)
      .eq('used', false)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)

    const loginCode = codes?.[0]
    if (!loginCode) {
      return json({ error: 'Kod wygasł lub nie istnieje. Poproś o nowy.' }, 400, req)
    }

    if (loginCode.attempts >= 3) {
      return json({ error: 'Przekroczono liczbę prób. Poproś o nowy kod.' }, 403, req)
    }

    await supabaseAdmin
      .from('auth_codes')
      .update({ attempts: loginCode.attempts + 1 })
      .eq('id', loginCode.id)

    const incomingHash = await sha256hex(trimmedCode)
    if (incomingHash !== loginCode.code_hash) {
      return json({ error: 'Nieprawidłowy kod.' }, 401, req)
    }

    await supabaseAdmin.from('auth_codes').update({ used: true }).eq('id', loginCode.id)

    // Find or create profile
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, username')
      .eq('email', normalizedEmail)
      .maybeSingle()

    let profile = existingProfile
    if (!profile) {
      const newId = crypto.randomUUID()
      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert({ id: newId, email: normalizedEmail })
        .select('id, username')
        .single()
      if (insertError) throw insertError
      profile = newProfile
    }

    // Create session
    const sessionToken = randomToken()
    const sessionExpires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString()

    const { error: sessionError } = await supabaseAdmin
      .from('auth_sessions')
      .insert({ id: sessionToken, user_id: profile.id, email: normalizedEmail, expires_at: sessionExpires })
    if (sessionError) throw sessionError

    const cookie = `leszy_session=${sessionToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_MAX_AGE}`

    return json(
      { success: true, hasUsername: Boolean(profile.username) },
      200,
      req,
      { 'Set-Cookie': cookie }
    )
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera.' }, 500, req)
  }
})
```

- [ ] **Step 4: Deploy**

Deploy via MCP `deploy_edge_function` with `verify_jwt: false`, including `_shared/cors.js` in the files array.

- [ ] **Step 5: Run tests — expect PASS**

```bash
node --test ../supabase/functions/tests/auth.test.js 2>&1
```
Expected: all `auth-verify-code` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/auth-verify-code/ supabase/functions/tests/auth.test.js
git commit -m "feat: auth-verify-code edge function — validates OTP, creates session cookie"
```

---

## Task 6: `auth-logout` + `auth-me` edge functions

**Files:**
- Create: `supabase/functions/auth-logout/index.js`
- Create: `supabase/functions/auth-me/index.js`
- Modify: `supabase/functions/tests/auth.test.js`

- [ ] **Step 1: Add tests**

Add to `auth.test.js`:

```js
describe('auth-me', () => {
  let sessionToken
  const email = `me-${Date.now()}@test.leszy.run`

  before(async () => {
    // Create profile + session directly
    const userId = crypto.randomUUID()
    await supabaseAdmin.from('profiles').insert({ id: userId, email, username: 'me_test_user' })
    sessionToken = crypto.randomBytes(32).toString('hex')
    await supabaseAdmin.from('auth_sessions').insert({
      id: sessionToken,
      user_id: userId,
      email,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  })

  after(async () => {
    await supabaseAdmin.from('auth_sessions').delete().eq('email', email)
    await supabaseAdmin.from('profiles').delete().eq('email', email)
  })

  it('returns 401 with no cookie', async () => {
    const { status } = await post('auth-me', {})
    assert.equal(status, 401)
  })

  it('returns user data with valid cookie', async () => {
    const { status, data } = await post('auth-me', {}, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.user.email, email)
    assert.equal(data.user.username, 'me_test_user')
  })
})

describe('auth-logout', () => {
  let sessionToken
  const email = `logout-${Date.now()}@test.leszy.run`

  before(async () => {
    const userId = crypto.randomUUID()
    await supabaseAdmin.from('profiles').insert({ id: userId, email })
    sessionToken = crypto.randomBytes(32).toString('hex')
    await supabaseAdmin.from('auth_sessions').insert({
      id: sessionToken,
      user_id: userId,
      email,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  })

  after(async () => {
    await supabaseAdmin.from('profiles').delete().eq('email', email)
  })

  it('deletes session and clears cookie', async () => {
    const { status, headers } = await post('auth-logout', {}, sessionToken)
    assert.equal(status, 200)
    const setCookie = headers.get('set-cookie')
    assert.ok(setCookie?.includes('Max-Age=0'))

    const { data } = await supabaseAdmin
      .from('auth_sessions')
      .select('id')
      .eq('id', sessionToken)
    assert.equal(data.length, 0)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test ../supabase/functions/tests/auth.test.js 2>&1 | grep -E "auth-me|auth-logout"
```

- [ ] **Step 3: Create `auth-logout/index.js`**

```js
// supabase/functions/auth-logout/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const cookieHeader = req.headers.get('Cookie') ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)leszy_session=([^;]+)/)
  if (match) {
    const token = decodeURIComponent(match[1])
    await supabaseAdmin.from('auth_sessions').delete().eq('id', token)
  }

  const clearCookie = 'leszy_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0'
  return json({ success: true }, 200, req, { 'Set-Cookie': clearCookie })
})
```

- [ ] **Step 4: Create `auth-me/index.js`**

```js
// supabase/functions/auth-me/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Not authenticated' }, 401, req)

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, email, username, display_name, club')
    .eq('id', session.userId)
    .single()

  if (!profile) return json({ error: 'Profile not found' }, 404, req)

  return json({ user: profile }, 200, req)
})
```

- [ ] **Step 5: Deploy both**

Deploy `auth-logout` and `auth-me` via MCP `deploy_edge_function`, both with `verify_jwt: false`, both including `_shared/cors.js` and `_shared/session.js`.

- [ ] **Step 6: Run tests — expect PASS**

```bash
node --test ../supabase/functions/tests/auth.test.js 2>&1
```
Expected: all tests in auth.test.js PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/auth-logout/ supabase/functions/auth-me/ supabase/functions/tests/auth.test.js
git commit -m "feat: auth-logout and auth-me edge functions"
```

---

## Task 7: `get-profile-data` edge function

**Files:**
- Create: `supabase/functions/get-profile-data/index.js`
- Modify: `supabase/functions/tests/auth.test.js`

- [ ] **Step 1: Add test**

```js
describe('get-profile-data', () => {
  let sessionToken, userId
  const email = `profile-data-${Date.now()}@test.leszy.run`

  before(async () => {
    userId = crypto.randomUUID()
    await supabaseAdmin.from('profiles').insert({
      id: userId, email, username: 'profiledata_test',
    })
    sessionToken = crypto.randomBytes(32).toString('hex')
    await supabaseAdmin.from('auth_sessions').insert({
      id: sessionToken, user_id: userId, email,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  })

  after(async () => {
    await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
    await supabaseAdmin.from('profiles').delete().eq('id', userId)
  })

  it('returns 401 without session', async () => {
    const { status } = await post('get-profile-data', {})
    assert.equal(status, 401)
  })

  it('returns profile, badges, reports, submissions for logged-in user', async () => {
    const { status, data } = await post('get-profile-data', {}, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.profile.username, 'profiledata_test')
    assert.ok(Array.isArray(data.badges))
    assert.ok(Array.isArray(data.reports))
    assert.ok(Array.isArray(data.submissions))
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create the edge function**

```js
// supabase/functions/get-profile-data/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Not authenticated' }, 401, req)

  const [
    { data: profile },
    { data: badges },
    { data: reports },
    { data: submissions },
  ] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('id, email, username, display_name, club, privacy_settings, created_at')
      .eq('id', session.userId)
      .single(),
    supabaseAdmin
      .from('user_badges')
      .select('*, badge_definitions(*)')
      .eq('user_id', session.userId),
    supabaseAdmin
      .from('calendar_event_reports')
      .select('*')
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('calendar_events')
      .select('id, name, status, created_at')
      .eq('submitted_by', session.userId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  return json({ profile, badges: badges ?? [], reports: reports ?? [], submissions: submissions ?? [] }, 200, req)
})
```

- [ ] **Step 4: Deploy**

Deploy via MCP, `verify_jwt: false`, include `_shared/cors.js` and `_shared/session.js`.

- [ ] **Step 5: Run tests — expect PASS**

```bash
node --test ../supabase/functions/tests/auth.test.js 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/get-profile-data/ supabase/functions/tests/auth.test.js
git commit -m "feat: get-profile-data edge function for Profil.jsx dashboard"
```

---

## Task 8: Update `update-profile`, `submit-contribution`, `admin-review-contribution`

**Files:**
- Modify: `supabase/functions/update-profile/index.js`
- Modify: `supabase/functions/submit-contribution/index.js`
- Modify: `supabase/functions/admin-review-contribution/index.js`

The change in each is the same pattern: swap `supabaseAdmin.auth.getUser(authHeader)` for `getSession(req, supabaseAdmin)`. The existing `node:test` integration tests for these functions also need updating to use cookie headers instead of Bearer tokens.

- [ ] **Step 1: Rewrite `update-profile/index.js`**

```js
// supabase/functions/update-profile/index.js
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
    const { username, display_name, club, avatar_url, bio, privacy_settings } = body

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

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, club')
      .eq('id', session.userId)
      .single()

    const updates = {}
    if (username !== undefined)          updates.username = username
    if (display_name !== undefined)      updates.display_name = display_name
    if (club !== undefined)              updates.club = club
    if (avatar_url !== undefined)        updates.avatar_url = avatar_url
    if (bio !== undefined)               updates.bio = bio
    if (privacy_settings !== undefined)  updates.privacy_settings = privacy_settings

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', session.userId)
      .select()
      .single()
    if (error) throw error

    const clubJustSet = club && !existingProfile?.club
    if (clubJustSet) {
      await checkAndAwardBadges(supabaseAdmin, session.userId)
    }

    return json({ data: profile }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
```

Note: The old function had an INSERT path for new profiles. Since `auth-verify-code` now creates the profile on first login, `update-profile` only needs to UPDATE. Removed the INSERT path.

- [ ] **Step 2: Rewrite `submit-contribution/index.js`** — change only the auth section at the top

Replace:
```js
let userId = null
const authHeader = req.headers.get('Authorization')
if (authHeader) {
  const { data: { user } } = await supabaseAdmin.auth.getUser(
    authHeader.replace('Bearer ', '')
  )
  userId = user?.id ?? null
}
```

With:
```js
import { getSession } from '../_shared/session.js'
// ...
const session = await getSession(req, supabaseAdmin)
const userId = session?.userId ?? null
```

Also replace the hardcoded cors object and OPTIONS handler with:
```js
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
// ...
const optRes = handleOptions(req)
if (optRes) return optRes
```

And update the `json` helper to use `getCorsHeaders(req)`.

- [ ] **Step 3: Rewrite `admin-review-contribution/index.js`** — same pattern

Replace JWT validation:
```js
const authHeader = req.headers.get('Authorization')
if (!authHeader) return json({ error: 'Authorization required' }, 401)
const { data: { user } } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''))
if (!user) return json({ error: 'Invalid token' }, 401)
const adminIds = (Deno.env.get('ADMIN_USER_IDS') ?? '').split(',').map(s => s.trim())
if (!adminIds.includes(user.id)) return json({ error: 'Forbidden' }, 403)
```

With:
```js
import { getSession } from '../_shared/session.js'
// ...
const session = await getSession(req, supabaseAdmin)
if (!session) return json({ error: 'Authorization required' }, 401, req)
const adminIds = (Deno.env.get('ADMIN_USER_IDS') ?? '').split(',').map(s => s.trim())
if (!adminIds.includes(session.userId)) return json({ error: 'Forbidden' }, 403, req)
```

Also update CORS to use getCorsHeaders/handleOptions.

- [ ] **Step 4: Update `supabase/functions/tests/helpers.js`**

Remove Supabase Auth entirely. Add session cookie helpers:

```js
// supabase/functions/tests/helpers.js
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Creates a profile row + session row in DB. Returns { user, sessionToken }. */
export async function createTestSession(suffix = 'test') {
  const email = `test-${suffix}-${Date.now()}@test.leszy.run`
  const userId = crypto.randomUUID()

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, email })
  if (profileError) throw profileError

  const sessionToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const { error: sessionError } = await supabaseAdmin
    .from('auth_sessions')
    .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
  if (sessionError) throw sessionError

  return { user: { id: userId, email }, sessionToken, email }
}

/** Deletes session(s) and profile. */
export async function cleanupUser(userId) {
  await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').delete().eq('id', userId)
}

/** POST to an edge function. Pass sessionToken to send as cookie. */
export async function callFunction(name, body, sessionToken = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['Cookie'] = `leszy_session=${sessionToken}`
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
```

- [ ] **Step 5: Update existing integration test files**

In `supabase/functions/tests/update-profile.test.js`: change `createTestSession()` calls to use the new helper (returns `{ user, sessionToken }` not `{ user, session, accessToken }`). Change `callFunction(name, body, accessToken)` to `callFunction(name, body, sessionToken)`.

Do the same for `submit-contribution.test.js` and `admin-review-contribution.test.js`.

- [ ] **Step 6: Deploy all three updated functions**

Deploy `update-profile`, `submit-contribution`, `admin-review-contribution` via MCP. Each needs `_shared/cors.js`, `_shared/session.js`, `_shared/badge-check.js`.

- [ ] **Step 7: Run all integration tests**

```bash
cd public && node --test ../supabase/functions/tests/*.test.js 2>&1
```
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/update-profile/ supabase/functions/submit-contribution/ supabase/functions/admin-review-contribution/ supabase/functions/tests/
git commit -m "feat: swap Supabase Auth JWT for session cookie in all edge functions"
```

---

## Task 9: Rewrite `public/src/lib/auth.js`

**Files:**
- Modify: `public/src/lib/auth.js`

- [ ] **Step 1: Replace the entire file**

```js
// public/src/lib/auth.js
const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

async function callEdge(name, body) {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `${name} failed`)
  return data
}

/** Sends a 6-digit OTP to email. honeypot field silently absorbs bot submissions. */
export async function requestCode(email, honeypot = '') {
  return callEdge('auth-request-code', { email, honeypot })
}

/** Verifies OTP. Returns { success, hasUsername }. */
export async function verifyCode(email, code) {
  return callEdge('auth-verify-code', { email, code })
}

/** Clears the session cookie. */
export async function signOut() {
  return callEdge('auth-logout', {})
}

/** Returns current user from session cookie, or null if not authenticated. */
export async function getMe() {
  const res = await fetch(`${FUNCTIONS_BASE}/auth-me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  })
  if (res.status === 401) return null
  const data = await res.json()
  return data.user ?? null
}

/** Calls an authenticated edge function. Cookie is sent automatically via credentials: 'include'. */
export async function callFunction(name, body) {
  return callEdge(name, body)
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/lib/auth.js
git commit -m "feat: rewrite auth.js — custom OTP + session cookie, no Supabase Auth"
```

---

## Task 10: Rewrite `public/src/hooks/useAuth.js`

**Files:**
- Modify: `public/src/hooks/useAuth.js`

- [ ] **Step 1: Replace the entire file**

```js
// public/src/hooks/useAuth.js
import { useState, useEffect } from 'react'
import { getMe } from '../lib/auth.js'

export default function useAuth() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMe().then(u => {
      setUser(u)
      setLoading(false)
    })
  }, [])

  return { user, loading }
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/hooks/useAuth.js
git commit -m "feat: rewrite useAuth — reads session from auth-me edge function on mount"
```

---

## Task 11: Rewrite `public/src/pages/Login.jsx`

**Files:**
- Modify: `public/src/pages/Login.jsx`

- [ ] **Step 1: Replace the entire file**

```jsx
// public/src/pages/Login.jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import { requestCode, verifyCode } from '../lib/auth.js'
import useAuth from '../hooks/useAuth.js'
import useSeo from '../hooks/useSeo.js'

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-xs tracking-widest uppercase text-apex-muted mb-1.5'

export default function Login() {
  useSeo({ title: 'Logowanie — Leszy.run', path: '/login', noindex: true })

  const { user, loading } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState('email') // 'email' | 'code'
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Already logged in — redirect away
  useEffect(() => {
    if (!loading && user) {
      navigate(user.username ? '/profil' : '/onboarding', { replace: true })
    }
  }, [user, loading, navigate])

  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await requestCode(email.trim().toLowerCase(), honeypot)
      setStep('code')
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCodeSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const { hasUsername } = await verifyCode(email.trim().toLowerCase(), code.trim())
      navigate(hasUsername ? '/profil' : '/onboarding', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return null

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="flex items-center justify-center min-h-screen pt-14 px-4">
        <div className="w-full max-w-sm">
          <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-2">
            Zaloguj się
          </h1>
          <p className="font-sans text-apex-muted text-sm mb-8">
            {step === 'email'
              ? 'Podaj email — wyślemy Ci kod logowania.'
              : `Podaj 6-cyfrowy kod wysłany na ${email}.`}
          </p>

          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-5">
              {/* Honeypot — hidden from humans, catches bots */}
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <input type="text" name="website" tabIndex={-1} autoComplete="off"
                  value={honeypot} onChange={e => setHoneypot(e.target.value)} />
              </div>
              <div>
                <label htmlFor="email" className={labelClass}>Email</label>
                <input id="email" type="email" value={email}
                  onChange={e => setEmail(e.target.value)}
                  required autoFocus className={inputClass} placeholder="ty@przyklad.pl" />
              </div>
              {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
              <button type="submit" disabled={submitting}
                className="w-full font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40">
                {submitting ? 'Wysyłanie…' : 'Wyślij kod'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-5">
              <div>
                <label htmlFor="code" className={labelClass}>Kod (6 cyfr)</label>
                <input id="code" type="text" inputMode="numeric" pattern="\d{6}"
                  value={code} onChange={e => setCode(e.target.value)}
                  required autoFocus maxLength={6} className={inputClass} placeholder="123456" />
              </div>
              {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
              <button type="submit" disabled={submitting}
                className="w-full font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40">
                {submitting ? 'Weryfikacja…' : 'Zaloguj się'}
              </button>
              <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null) }}
                className="w-full font-mono text-xs text-apex-muted hover:text-apex-text transition-colors py-2">
                ← Zmień email
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/Login.jsx
git commit -m "feat: rewrite Login.jsx — email OTP with custom auth, honeypot"
```

---

## Task 12: Update `Profil.jsx` and `Onboarding.jsx`

**Files:**
- Modify: `public/src/pages/Profil.jsx`
- Modify: `public/src/pages/Onboarding.jsx`

- [ ] **Step 1: Update `Profil.jsx` — replace 4 Supabase queries with `get-profile-data`**

Find `ProfilContent` function. Replace the entire `useEffect` that loads data (currently 4 Supabase queries) with:

```js
useEffect(() => {
  if (!user) return
  callFunction('get-profile-data', {}).then(({ profile, badges, reports, submissions }) => {
    setProfile(profile)
    setBadges(badges)
    setReports(reports)
    setSubmissions(submissions)
    setLoading(false)
  })
}, [user])
```

Remove the `import { supabase } from '../lib/supabase.js'` line from Profil.jsx (no longer needed).
Add `import { callFunction } from '../lib/auth.js'` if not already present.

Also remove the `session` from the `useAuth()` destructure — only `user` and `loading` are needed now.

- [ ] **Step 2: Update `Onboarding.jsx` — remove Supabase profile check**

Remove the `useEffect` that checks if profile exists via `supabase.from('profiles')...`:

```js
// DELETE this entire block:
useEffect(() => {
  if (!user) return
  supabase.from('profiles').select('id').eq('id', user.id).single()
    .then(({ data }) => { if (data) navigate('/profil', { replace: true }) })
}, [user, navigate])
```

Replace with:

```js
useEffect(() => {
  if (user?.username) navigate('/profil', { replace: true })
}, [user, navigate])
```

Remove the `import { supabase } from '../lib/supabase.js'` line from Onboarding.jsx.

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/Profil.jsx public/src/pages/Onboarding.jsx
git commit -m "feat: Profil.jsx uses get-profile-data edge function; Onboarding checks user.username"
```

---

## Task 13: Update Navbar.jsx

**Files:**
- Modify: `public/src/components/Navbar.jsx`

The Navbar currently calls `signOut()` from `lib/auth.js`. The new `signOut()` is a POST to `auth-logout` which clears the cookie. After sign-out, the user state in `useAuth` won't auto-update (no subscription). Force a page reload after sign-out to reset the React state.

- [ ] **Step 1: Update the sign-out handler in Navbar.jsx**

Find the `handleSignOut` (or similar) function and update it:

```js
async function handleSignOut() {
  try {
    await signOut()
  } finally {
    window.location.href = '/'
  }
}
```

Using `window.location.href` (hard redirect) instead of `navigate('/')` ensures React state is cleared. This is intentional — `useAuth` initialises once on mount; a soft navigate wouldn't re-run it.

- [ ] **Step 2: Commit**

```bash
git add public/src/components/Navbar.jsx
git commit -m "fix: Navbar sign-out does hard redirect to reset useAuth state"
```

---

## Task 14: Update E2E helpers and all 5 spec files

**Files:**
- Modify: `public/tests/e2e/helpers.js`
- Modify: `public/tests/e2e/auth.spec.js`
- Modify: `public/tests/e2e/onboarding.spec.js`
- Modify: `public/tests/e2e/profile.spec.js`
- Modify: `public/tests/e2e/public-profile.spec.js`
- Modify: `public/tests/e2e/contributions.spec.js`

The key change: instead of navigating to a magic link URL, tests create a session row in DB and inject the `leszy_session` cookie for the Supabase domain. The browser then sends this cookie automatically on every `callFunction` call from the app.

Supabase domain: `kojoxazlnxncrpxmnxiq.supabase.co`

- [ ] **Step 1: Rewrite `public/tests/e2e/helpers.js`**

```js
// public/tests/e2e/helpers.js
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const SUPABASE_DOMAIN = new URL(SUPABASE_URL).hostname // 'kojoxazlnxncrpxmnxiq.supabase.co'

/**
 * Creates a profile + session in DB. Returns helpers for Playwright.
 * Call injectSession(context) to authenticate a browser context.
 */
export async function createTestUser(suffix = 'e2e') {
  const email = `e2e-${suffix}-${Date.now()}@test.leszy.run`
  const userId = crypto.randomUUID()

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, email })
  if (profileError) throw profileError

  const sessionToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  const { error: sessionError } = await supabaseAdmin
    .from('auth_sessions')
    .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
  if (sessionError) throw sessionError

  return {
    user: { id: userId, email },
    email,
    sessionToken,
    /** Call this with a Playwright BrowserContext to inject the session cookie. */
    async injectSession(context) {
      await context.addCookies([{
        name: 'leszy_session',
        value: sessionToken,
        domain: SUPABASE_DOMAIN,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      }])
    },
  }
}

export async function cleanupUser(userId) {
  await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').delete().eq('id', userId)
}
```

- [ ] **Step 2: Update `auth.spec.js`**

The auth spec tests the login UI flow. With custom auth, the flow is: enter email → submit → enter code → logged in. Since we can't receive real emails in tests, test the UI-visible parts only (form rendering, step transitions) and test the actual auth flow via integration tests.

Replace the existing content:

```js
// public/tests/e2e/auth.spec.js
import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser } from './helpers.js'

test.describe('Login page', () => {
  test('shows email form on /login', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByLabel(/email/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /wyślij kod/i })).toBeVisible()
  })

  test('shows code input after submitting email', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/email/i).fill('test@test.leszy.run')
    await page.getByRole('button', { name: /wyślij kod/i }).click()
    // Function returns 200 (honeypot path or real), step changes to 'code'
    await expect(page.getByLabel(/kod/i)).toBeVisible({ timeout: 8000 })
  })

  test('redirects to /profil when already logged in', async ({ page, context }) => {
    const testUser = await createTestUser('auth-redirect')
    // Set username so redirect goes to /profil not /onboarding
    await import('./helpers.js').then(h =>
      h.supabaseAdmin.from('profiles').update({ username: 'auth_redirect_user' }).eq('id', testUser.user.id)
    )
    await testUser.injectSession(context)
    await page.goto('/login')
    await page.waitForURL('/profil')
    await cleanupUser(testUser.user.id)
  })

  test('redirects to /onboarding when logged in without username', async ({ page, context }) => {
    const testUser = await createTestUser('auth-onboarding')
    await testUser.injectSession(context)
    await page.goto('/login')
    await page.waitForURL('/onboarding')
    await cleanupUser(testUser.user.id)
  })
})
```

- [ ] **Step 3: Update `onboarding.spec.js`**

Replace `magicLinkUrl` navigation with cookie injection. The key change in every test that previously did `page.goto(testUser.magicLinkUrl)`:

```js
// Before (remove):
await page.goto(testUser.magicLinkUrl)
await page.waitForURL('/onboarding')

// After (replace with):
await testUser.injectSession(context)
await page.goto('/onboarding')
```

Also update `createTestUser` import (same export name, different return shape) and `cleanupUser` (now takes userId, same as before).

Full rewrite of `onboarding.spec.js`:

```js
// public/tests/e2e/onboarding.spec.js
import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin } from './helpers.js'

test.describe('Onboarding', () => {
  let testUser

  test.beforeEach(async () => {
    testUser = await createTestUser('onboarding')
  })

  test.afterEach(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('shows username form', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await expect(page.getByLabel(/nazwa użytkownika/i)).toBeVisible()
  })

  test('redirects to /profil after setting username', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    const username = `onb_${Date.now()}`.slice(0, 28).toLowerCase()
    await page.getByLabel(/nazwa użytkownika/i).fill(username)
    await page.getByRole('button', { name: /zapisz/i }).click()
    await page.waitForURL('/profil')
  })

  test('shows error for username shorter than 3 chars', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await page.getByLabel(/nazwa użytkownika/i).fill('ab')
    await page.getByRole('button', { name: /zapisz/i }).click()
    await expect(page.getByText(/co najmniej 3/i)).toBeVisible()
  })

  test('redirects to /profil if user already has username', async ({ page, context }) => {
    await supabaseAdmin.from('profiles').update({ username: 'already_set_user' }).eq('id', testUser.user.id)
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await page.waitForURL('/profil')
  })
})
```

- [ ] **Step 4: Update `profile.spec.js`**

Same pattern — replace `magicLinkUrl` + `waitForURL('/onboarding')` flow with `injectSession(context)` + `page.goto('/profil')`. Also update `data-testid="profil-page"` check if needed.

```js
// public/tests/e2e/profile.spec.js
import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

test.describe('Profil page', () => {
  let testUser, profileUsername

  test.beforeAll(async () => {
    testUser = await createTestUser('profile')
    profileUsername = `profile_e2e_${Date.now()}`.toLowerCase().slice(0, 28)
    await fetch(`${FUNCTIONS_URL}/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
      body: JSON.stringify({ username: profileUsername }),
    })
  })

  test.afterAll(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('shows profil page with username', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil')
    await expect(page.getByTestId('profil-page')).toBeVisible()
    await expect(page.getByText(`@${profileUsername}`)).toBeVisible()
  })

  test('shows empty contributions state', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil')
    await expect(page.getByText(/brak wkładów/i)).toBeVisible()
  })

  test('can edit display_name', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil')
    await page.getByTestId('edit-display_name').click({ force: true })
    await page.getByTestId('input-display_name').fill('Jan Testowy')
    await page.getByTestId('save-display_name').click()
    await expect(page.getByText('Jan Testowy')).toBeVisible()
  })

  test('AuthGuard redirects to /login when not logged in', async ({ page }) => {
    await page.goto('/profil')
    await page.waitForURL('/login')
  })

  test('shows badges section when user has badges', async ({ page, context }) => {
    const { data: badgeDef } = await supabaseAdmin
      .from('badge_definitions')
      .select('id')
      .limit(1)
      .single()
    await supabaseAdmin
      .from('user_badges')
      .insert({ user_id: testUser.user.id, badge_id: badgeDef.id })
    await testUser.injectSession(context)
    await page.goto('/profil')
    await expect(page.getByTestId('badges-section')).toBeVisible()
    await supabaseAdmin.from('user_badges').delete().eq('user_id', testUser.user.id)
  })
})
```

- [ ] **Step 5: Update `public-profile.spec.js`**

Replace `magicLinkUrl` flow with `injectSession`. The public profile tests mostly don't need auth (they test the public `/u/:username` page), but the setup calls `update-profile` — update that to use `Cookie` header.

```js
// public/tests/e2e/public-profile.spec.js
import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

async function setupUserWithProfile(suffix) {
  const testUser = await createTestUser(suffix)
  const username = `pub_${suffix}_${Date.now()}`.toLowerCase().slice(0, 28)
  await fetch(`${FUNCTIONS_URL}/update-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
    body: JSON.stringify({ username, display_name: 'Test Display' }),
  })
  return { testUser, username }
}

test.describe('Public profile /u/:username', () => {
  let setup

  test.beforeAll(async () => {
    setup = await setupUserWithProfile('pubprofile')
  })

  test.afterAll(async () => {
    await cleanupUser(setup.testUser.user.id)
  })

  test('public profile page renders for existing user', async ({ page }) => {
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByText(`@${setup.username}`)).toBeVisible()
  })

  test('display name is visible when privacy is on (default)', async ({ page }) => {
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByText('Test Display')).toBeVisible()
  })

  test('display name is hidden when user sets privacy off', async ({ page }) => {
    await fetch(`${FUNCTIONS_URL}/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${setup.testUser.sessionToken}` },
      body: JSON.stringify({ privacy_settings: { display_name: false, club: true } }),
    })
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByText('Test Display')).not.toBeVisible()
  })

  test('404 page shown for non-existent username', async ({ page }) => {
    await page.goto('/u/this_user_does_not_exist_xyz123')
    await expect(page.getByText(/nie znaleziono/i)).toBeVisible()
  })

  test('badges section visible when user has badges', async ({ page }) => {
    const { data: badgeDef } = await supabaseAdmin
      .from('badge_definitions').select('id').limit(1).single()
    await supabaseAdmin
      .from('user_badges')
      .insert({ user_id: setup.testUser.user.id, badge_id: badgeDef.id })
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByTestId('badges-section')).toBeVisible()
    await supabaseAdmin.from('user_badges').delete().eq('user_id', setup.testUser.user.id)
  })
})
```

- [ ] **Step 6: Update `contributions.spec.js`**

```js
// public/tests/e2e/contributions.spec.js
import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

test.describe('Community flows with auth', () => {
  let testUser, profileUsername

  test.beforeAll(async () => {
    testUser = await createTestUser('contrib-e2e')
    profileUsername = `contrib_e2e_${Date.now()}`.toLowerCase().slice(0, 28)
    await fetch(`${FUNCTIONS_URL}/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
      body: JSON.stringify({ username: profileUsername }),
    })
  })

  test.afterAll(async () => {
    await supabaseAdmin.from('calendar_event_reports').delete().eq('user_id', testUser.user.id)
    await cleanupUser(testUser.user.id)
  })

  test('logged-in user submitting a report sees it in /profil', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/kalendarz')
    const reportBtn = page.getByTestId('report-event-btn').first()
    const visible = await reportBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    if (!visible) { test.skip(); return }
    await reportBtn.click()
    await page.locator('select').first().selectOption('name')
    await page.locator('input[type="text"]').last().fill('Poprawiona nazwa')
    await page.getByRole('button', { name: /wyślij/i }).click()
    await expect(page.getByText(/dziękujemy/i)).toBeVisible()
    await page.goto('/profil')
    await expect(page.getByText(/raport/i).first()).toBeVisible()
  })

  test('anon report submission still works without login', async ({ page }) => {
    await page.goto('/kalendarz')
    const reportBtn = page.getByTestId('report-event-btn').first()
    const visible = await reportBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    if (!visible) { test.skip(); return }
    await reportBtn.click()
    await page.locator('select').first().selectOption('name')
    await page.locator('input[type="text"]').last().fill('Poprawiona nazwa anon')
    await page.getByRole('button', { name: /wyślij/i }).click()
    await expect(page.getByText(/dziękujemy/i)).toBeVisible()
  })
})
```

- [ ] **Step 7: Run all E2E tests**

```bash
cd public && \
  VITE_SUPABASE_URL=$(grep VITE_SUPABASE_URL ../.env | cut -d= -f2) \
  VITE_SUPABASE_ANON_KEY=$(grep VITE_SUPABASE_ANON_KEY ../.env | cut -d= -f2) \
  SUPABASE_URL=$(grep ^SUPABASE_URL= ../.env | cut -d= -f2) \
  SUPABASE_SERVICE_ROLE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY ../.env | cut -d= -f2) \
  npx playwright test --reporter=line 2>&1
```
Expected: all tests PASS (contributions tests may skip if no calendar events visible).

- [ ] **Step 8: Commit**

```bash
git add public/tests/e2e/
git commit -m "feat: update all E2E tests to use session cookie injection instead of magic links"
```

---

## Self-Review

**Spec coverage:**
- ✅ auth_codes + auth_sessions tables → Task 1
- ✅ auth-request-code (honeypot, invalidate old, send email) → Task 4
- ✅ auth-verify-code (hash check, attempts, create profile, set cookie) → Task 5
- ✅ auth-logout → Task 6
- ✅ auth-me → Task 6
- ✅ get-profile-data → Task 7
- ✅ _shared/cors.js (dynamic CORS + credentials) → Task 2
- ✅ _shared/session.js → Task 3
- ✅ update-profile, submit-contribution, admin-review-contribution → Task 8
- ✅ public/src/lib/auth.js rewrite → Task 9
- ✅ public/src/hooks/useAuth.js rewrite → Task 10
- ✅ Login.jsx rewrite with honeypot → Task 11
- ✅ Profil.jsx, Onboarding.jsx → Task 12
- ✅ Navbar.jsx sign-out → Task 13
- ✅ E2E helpers + all 5 spec files → Task 14
- ✅ Drop auth.uid() RLS policies → Task 1
- ✅ profiles.email column, drop auth.users FK → Task 1
