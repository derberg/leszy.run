# Custom Email OTP Auth — Design Spec

**Goal:** Replace Supabase Auth with a custom email OTP + session cookie system. No vendor lock-in on auth. All authenticated operations go through Supabase Edge Functions.

**Architecture:** Edge functions handle all auth and authenticated data access. Session token stored in an httpOnly cookie (`leszy_session`). Supabase is just a database — the anon key is only used for public reads (calendar, event pages, public profiles). A shared `_shared/session.js` module validates the session cookie across all edge functions.

---

## DB Tables

Two new tables, no RLS anon access — all reads/writes via service_role through edge functions only.

### `auth_codes`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, gen_random_uuid() |
| `email` | text NOT NULL | |
| `code_hash` | text NOT NULL | sha256 of 6-digit plaintext code |
| `expires_at` | timestamptz NOT NULL | 10 minutes from creation |
| `attempts` | int NOT NULL DEFAULT 0 | max 3 before lockout |
| `used` | bool NOT NULL DEFAULT false | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

No FK to profiles — a code can be requested before a profile exists (first-time user).

### `auth_sessions`
| Column | Type | Notes |
|---|---|---|
| `id` | text PK | crypto.randomBytes(32).toString('hex') |
| `user_id` | uuid NOT NULL | FK to profiles.id |
| `email` | text NOT NULL | denormalised for auth-me without extra join |
| `expires_at` | timestamptz NOT NULL | 60 days from creation |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

---

## Edge Functions

### New: `_shared/session.js`
Exports `getSession(req, supabaseAdmin)` → `{ userId, email }` or `null`. Reads `leszy_session` cookie from request headers, looks up in `auth_sessions`, validates expiry.

### New: `auth-request-code`
- Input: `{ email, honeypot }`
- Honeypot non-empty → return 200 silently, no code sent
- Validates email format
- Invalidates previous unused codes for this email
- Generates 6-digit code, sha256-hashes it, inserts into `auth_codes` with 10-min expiry
- Sends email via SendGrid with the plaintext code
- Returns `{ success: true }` (always, even if email not found — don't leak existence)

### New: `auth-verify-code`
- Input: `{ email, code }`
- Finds most recent unused, non-expired `auth_codes` row for this email
- Increments attempts; rejects if attempts >= 3
- Compares sha256(code) to stored hash
- On match: marks code used, creates `auth_sessions` row, upserts `profiles` row (email only, if first login)
- Returns `Set-Cookie: leszy_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=5184000`

### New: `auth-logout`
- Reads `leszy_session` cookie, deletes matching `auth_sessions` row
- Returns `Set-Cookie` header that clears the cookie (Max-Age=0)

### New: `auth-me`
- Calls `getSession(req, supabaseAdmin)`
- Returns `{ user: { id, email, username, display_name, club } }` or 401

### New: `get-profile-data`
- Calls `getSession` → 401 if no session
- Returns in one response: profile row + badges + reports (last 50) + submissions (last 50)

### Modified: `update-profile`
- Swap `supabaseAdmin.auth.getUser(token)` for `getSession(req, supabaseAdmin)`
- Behaviour otherwise unchanged

### Modified: `submit-contribution`
- Swap JWT validation for `getSession` (stays optional — no cookie = anon path)

### Modified: `admin-review-contribution`
- Swap JWT validation for `getSession`
- Keep ADMIN_USER_IDS check against userId from session

---

## Frontend

### `public/src/lib/auth.js` — full rewrite
```
requestCode(email, honeypot)  → POST auth-request-code
verifyCode(email, code)       → POST auth-verify-code
signOut()                     → POST auth-logout
getMe()                       → GET auth-me → user or null
callFunction(name, body)      → POST /functions/v1/<name>, credentials: 'include', no JWT logic
```

### `public/src/hooks/useAuth.js` — rewrite
- On mount: calls `getMe()` to hydrate `{ user, loading }`
- No `onAuthStateChange` (no Supabase Auth)
- Exposes `{ user, loading }`

### `public/src/pages/Login.jsx` — rewrite
- Same two-step UX: email input → 6-digit code input
- Hidden honeypot field passed to `requestCode`
- Wired to `requestCode` / `verifyCode`
- On success: check if `username` set → redirect to `/onboarding` or `/profil`

### `public/src/pages/Profil.jsx` — update
- Replace 4 direct Supabase queries with single `callFunction('get-profile-data')` call

### Unchanged
- `public/src/components/AuthGuard.jsx` — no changes
- `public/src/lib/supabase.js` — kept for public reads
- All public-facing pages that read `calendar_events`, `profiles_public`, `user_badges` via anon key

---

## RLS Changes

Drop (access now controlled at edge function layer, not DB):
- `profiles` — remove owner-only SELECT policy (`auth.uid() = id`)
- `calendar_event_reports` — remove own-rows SELECT policy (`auth.uid() = user_id`)

Keep everything else:
- `calendar_events` public_read ✓
- `user_badges` public SELECT ✓
- `profiles_public` view public SELECT ✓
- All INSERT policies unchanged

---

## Testing

### E2E helpers — simplified
No more magic link URL flow. Tests inject a session cookie directly:

```js
// helpers.js
export async function createTestSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expires_at = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  await supabaseAdmin.from('auth_sessions').insert({ id: token, user_id: userId, expires_at })
  return token
}

// In test:
const token = await createTestSession(user.id)
await context.addCookies([{ name: 'leszy_session', value: token, domain: 'localhost', path: '/' }])
```

### Edge function integration tests
Auth flow tests use the admin client to insert a known code hash, then call `auth-verify-code` with the matching plaintext. No real email sent during tests.

### Existing E2E specs (auth, onboarding, profile, public-profile, contributions)
All updated to use `createTestSession` + `addCookies` instead of `magicLinkUrl` navigation.
