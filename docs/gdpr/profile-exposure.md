# Profile exposure audit

**Date:** 2026-06-04
**Reviewed function:** [supabase/functions/get-profile-data/index.js](../../supabase/functions/get-profile-data/index.js)

## Method

Read the function, traced the code path for an unauthenticated caller vs the profile owner.
Also read `UserProfile.jsx` (the public `/u/:username` page) and queried the `profiles_public`
view definition and RLS policies to confirm the full surface.

## Architecture note

There are **two separate profile surfaces** in this app:

1. **`/profil`** — the authenticated owner's own edit page. Uses the `get-profile-data` edge
   function via `callFunction()`. Behind `<AuthGuard>` in the React router.

2. **`/u/:username`** — the public profile page visible to anyone. Does NOT use the
   `get-profile-data` edge function at all. Reads directly from the `profiles_public`
   Supabase view via the browser-side `supabase-js` client.

## Findings (before fix)

### `get-profile-data` edge function

| Field | Anon caller | Owner | OK? | Action |
|---|---|---|---|---|
| username | ❌ (401 before query) | ✅ | ✅ | No change |
| display_name | ❌ (401 before query) | ✅ | ✅ | No change |
| club name | ❌ (401 before query) | ✅ | ✅ | No change |
| voivodeship | ❌ (401 before query) | ✅ | ✅ | No change |
| city | ❌ (401 before query) | ✅ | ✅ | No change |
| date_of_birth | ❌ (401 before query) | ✅ | ✅ | No change |
| gender | ❌ (401 before query) | ✅ | ✅ | No change |
| phone | ❌ (401 before query) | ✅ | ✅ | No change |
| email | ❌ (401 before query) | ✅ | ✅ | No change |
| contributions | ❌ (401 before query) | ✅ (all statuses) | ✅ | No change |
| badges | ❌ (401 before query) | ✅ | ✅ | No change |

**Reason:** Line 24 of the function hard-gates all callers:
```js
const session = await getSession(req, supabaseAdmin)
if (!session) return json({ error: 'Not authenticated' }, 401, req)
```
No DB query runs for unauthenticated callers. The function then exclusively queries
`session.userId` (the caller's own ID) — it cannot be used to fetch another user's data.

### `profiles_public` view (used by `/u/:username`)

The view only exposes:
`id, username, display_name (conditional on privacy_settings.display_name), club (conditional), bio (conditional), avatar_url, created_at`

| Field | Anon caller | OK? |
|---|---|---|
| username | ✅ | ✅ |
| display_name | ✅ if user enabled it | ✅ |
| club name | ✅ if user enabled it | ✅ |
| voivodeship | ❌ not in view | ✅ |
| city | ❌ not in view | ✅ |
| date_of_birth | ❌ not in view | ✅ |
| gender | ❌ not in view | ✅ |
| phone | ❌ not in view | ✅ |
| email | ❌ not in view | ✅ |

### Contributions shown on public profile (`UserProfile.jsx`)

The public `/u/:username` page fetches contributions from two tables directly:

- **`calendar_event_reports`**: filtered `.in('status', ['accepted', 'pending'])` — shows pending
  reports to anonymous visitors. However, the anon role has no SELECT policy on this table, so
  PostgREST returns 0 rows for anon callers. Effectively safe today, but fragile (relies on missing
  policy, not explicit denial). **See concern below.**

- **`calendar_events`**: filtered `.eq('submitted_by', p.id)` and only shows `name, status,
  created_at`. The `public_read` RLS policy allows anon SELECT. Submissions with `status !=
  'active'` (pending, rejected) are not explicitly filtered out in the query, but the UI only
  renders submissions where `s.status === 'active'` (line 103 of `UserProfile.jsx`), so pending
  and rejected submissions are correctly hidden from public view.

## Fixes applied

**Edge function (`get-profile-data/index.js`):** No code change required. Anon callers receive a
`401 Not Authenticated` response before any database query executes. The function is designed as a
"get my own profile" endpoint, not a cross-user lookup, so the anon-vs-owner distinction does not
apply.

**`profiles_public` view:** No change needed. The view already excludes all PII fields (city, DOB,
gender, phone, email).

## Concerns raised (for follow-up, not in scope of this task)

1. **Pending reports on public profile (low severity):** `UserProfile.jsx` queries
   `calendar_event_reports` with `.in('status', ['accepted', 'pending'])`. The only reason anon
   visitors don't see pending reports is the absence of a SELECT RLS policy, not an explicit
   `status = 'accepted'` filter. If a future migration adds a broader read policy to
   `calendar_event_reports`, pending reports would become publicly visible. The safer fix is to
   add `.eq('status', 'accepted')` to the query in `UserProfile.jsx`.

2. **`voivodeship` absent from public profile:** Per the plan spec, voivodeship is a public-safe
   field. It is currently absent from both `profiles_public` and the public profile UI. This is not
   a leak risk but may be a missing feature if voivodeship is intentionally public.

## Re-verified

- **Date:** 2026-06-04
- **Method:** Read the function code and `UserProfile.jsx` after audit; confirmed the edge function
  never executes a DB query for unauthenticated callers (401 gate on line 24), and `profiles_public`
  view excludes all PII columns. No code changes were needed to achieve the required field
  projection.
