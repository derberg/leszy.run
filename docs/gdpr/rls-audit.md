# Supabase RLS Audit

**Date:** 2026-06-04
**Method:** `mcp__supabase__get_advisors` (security) + `pg_policies` query + `information_schema.columns` + manual review.
**Auditor:** Task E5 — GDPR compliance plan.

---

## Supabase Security Advisor findings

Total lints: **97** across 8 categories.

### ERROR — policy_exists_rls_disabled (5 tables)

Policies exist but RLS is not actually enabled — the policies are dead letters. Any client can read/write without restriction.

| Table | Policy | Remediation |
|---|---|---|
| `public.categories` | "anon read categories" | Enable RLS (read-only so enabling + existing policy is safe) |
| `public.events` | "anon read events" | Enable RLS (same) |
| `public.gate_crossings` | "anon read gate_crossings" | Enable RLS |
| `public.race_runs` | "anon read race_runs" | Enable RLS |
| `public.results` | "anon read results" | Enable RLS |

### ERROR — rls_disabled_in_public (43 tables)

These tables have no RLS at all. 40 are scraper tables or internal pipeline tables (no PII, intentionally service-role-only). Three are data tables:

| Table | PII? | Notes |
|---|---|---|
| `public.participants` | **YES** — first_name, last_name, phone in local DB; mirrored to Supabase without phone | URGENT — see §Per-table review |
| `public.gate_events` | low | Raw RFID pings; EPC tags are not personal by themselves |
| `public.checkpoint_imports`, `public.checkpoint_readings` | no | Internal import staging |
| `public.dismissed_duplicates`, `public.event_partners` | no | Pipeline metadata |
| `public.badge_definitions` | no | Static badge catalogue |
| 34× `public.scraper_*` | no | Raw scraper dumps, no personal data |

### INFO — rls_enabled_no_policy (11 tables)

RLS is ON but there are zero policies. This means **service_role** can still access (bypasses RLS) but anon/authenticated are fully blocked. This is intentional for server-only tables but worth confirming for each.

| Table | Intended access | Assessment |
|---|---|---|
| `admin_actions` | server only | Correct — audit log, should never be client-readable |
| `auth_codes` | server only | Correct — OTP hashes, must not be readable |
| `auth_sessions` | server only | Correct — session tokens, must not be readable |
| `otp_throttle` | server only | Correct — rate-limit state |
| `event_secrets` | server only | Correct — check-in PINs |
| `geocode_cache` | server only | Correct — pipeline cache |
| `url_suggestions` | server only | Correct — pipeline staging |
| `pin_attempts` | server only | Correct — rate-limit state |
| `profiles` | **needs user policy** | Missing SELECT/UPDATE policies — see §Per-table review |
| `event_favorites` | **needs user policy** | Missing all CRUD policies — see §Per-table review |
| `event_notifications` | **needs user policy** | Missing all CRUD policies — see §Per-table review |

### WARN — rls_policy_always_true (3 tables)

`WITH CHECK (true)` on INSERT is intentional for these anonymous-submission tables. Documented as accepted trade-offs:

| Table | Policy | Verdict |
|---|---|---|
| `calendar_event_reports` | "Anyone can create reports" | **Accepted** — anonymous event correction is a feature, no PII stored |
| `checkpoint_observations` | "anon insert observations" | **Accepted** — volunteer checkpoint taps, no PII |
| `website_feedback` | "anon_insert_feedback" | **Accepted** — feedback form, email is optional and user-provided |

### WARN — anon/authenticated_security_definer_function_executable (20 warnings, 10 functions)

All 10 functions are intentionally callable by anon or authenticated (check-in flow RPCs, username availability, club search). The SECURITY DEFINER is required so they can bypass RLS to do their PIN-gated data access. These are **accepted trade-offs** — the security model relies on PIN verification inside the function body, not on RLS. See §SECURITY DEFINER functions below for detailed analysis.

### WARN — function_search_path_mutable (10 functions)

Functions without a fixed `search_path` are theoretically vulnerable to search-path hijacking if an attacker gains schema-write access. In practice, schema-write requires `service_role`, at which point RLS is moot anyway. **Deferred** — low practical risk, high remediation effort.

### WARN — auth_leaked_password_protection (1)

HaveIBeenPwned integration in Supabase Auth. This project uses **magic-link / OTP auth only** — no passwords exist. **Not applicable.**

### WARN — extension_in_public (1)

`pg_trgm` is in the public schema. **Deferred** — moving extensions requires recreating dependent indexes; this is a minor hygiene issue, not a GDPR concern.

### ERROR — security_definer_view (2 views)

| View | Concern | Verdict |
|---|---|---|
| `participants_public` | SECURITY DEFINER bypasses RLS on `participants` | **Accepted** — `participants` has no RLS, the view is a deliberate exposure-limiting shim. Columns exposed: id, bib_number, first_name, last_name, club, category_id, emoji, gender, deleted_at. No phone/email/rfid_epc. |
| `profiles_public` | SECURITY DEFINER bypasses RLS on `profiles` | **Accepted** — view respects `privacy_settings` JSONB flags before exposing display_name/bio/club. Raw profiles table is not accessible to anon. |

### WARN — public_bucket_allows_listing (1)

`partner-logos` bucket has a broad SELECT policy allowing clients to list all objects. Not a GDPR issue (logos are non-personal). **Deferred.**

---

## Per-table review

### public.profiles

- **RLS enabled:** YES
- **Policies:** NONE (rls_enabled_no_policy)
- **Columns with PII:** id (user UUID), username, display_name, email, phone, date_of_birth, gender, city, voivodeship, bio, avatar_url, club_id, privacy_settings, deleted_at, weekly_digest

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| — | SELECT | — | — | Any authed user reads any profile including email, phone, DOB | **URGENT: tighten** |
| — | UPDATE | — | — | Any authed user updates any profile | **URGENT: tighten** |
| — | INSERT | — | — | Any authed user inserts a profile row | **tighten** |
| — | DELETE | — | — | Any authed user deletes any profile | **tighten** |

**Required policies:**
- SELECT: `auth.uid() = id` (own row only). Public profile data is served via `profiles_public` view (no policies needed there since view is SECURITY DEFINER).
- UPDATE: `auth.uid() = id` (own row only). With check `auth.uid() = id`.
- INSERT: `auth.uid() = id` (own row only). With check `auth.uid() = id`.
- No DELETE policy needed (use `deleted_at` soft-delete, not hard delete).

**Status:** TIGHTEN — adding SELECT/UPDATE/INSERT own-row policies. *Awaiting user confirmation before applying.*

---

### public.participants

- **RLS enabled:** NO
- **Columns with PII:** id, first_name, last_name, bib_number, club, category_id, emoji, gender, deleted_at, rfid_epc (EPC tag number), status, phone (sync from local DB)

**Threat model:** Anon client can `SELECT * FROM participants` and get first/last names, bib numbers, and crucially **rfid_epc** (which enables replay attacks against RFID gates).

**Current mitigations:**
- `participants_public` view exposes only safe columns (no phone, no rfid_epc)
- View is GRANT SELECT TO anon/authenticated
- No GRANT on the base table is documented

**Check what grants exist on the base table:**

The `participants_public` view comment in `rls-policies.sql` says "Direct table access removed." However, because RLS is disabled, any client with the anon key can still run `SELECT * FROM participants` directly, bypassing the view entirely.

**Required fix:** Enable RLS on `participants` with a read policy scoped to non-PII columns, OR (preferred) enable RLS with no anon SELECT policy (forcing all anon access through the `participants_public` view via its SECURITY DEFINER).

**Status:** URGENT — enable RLS with no anon SELECT policy. The view stays as the access path. *Awaiting user confirmation.*

---

### public.consent_log

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| consent_log: select own | SELECT | `auth.uid() = user_id` | — | User reads own consent decisions only | OK |
| consent_log: insert own | INSERT | — | `auth.uid() = user_id` | User inserts own consent record only | OK |

**Assessment:** No UPDATE/DELETE policy — correct, consent records are immutable. Service_role (backend) can still insert entries for anon consent (when `user_id = NULL`). This is intentional. **OK.**

---

### public.auth_codes

- **RLS enabled:** YES
- **Policies:** NONE
- **Columns with PII:** email, code_hash, purpose, attempts, used, expires_at

**Assessment:** No anon/authenticated policy = no client access. Only `service_role` (backend OTP logic) reads/writes this table. Backend never exposes raw rows through API. **OK — server-only table, no policy needed.**

---

### public.auth_sessions

- **RLS enabled:** YES
- **Policies:** NONE
- **Columns with PII:** user_id (UUID), email, session token (id), expires_at

**Assessment:** Same as auth_codes — server-only. **OK.**

---

### public.otp_throttle

- **RLS enabled:** YES
- **Policies:** NONE
- **Columns:** key (email or IP), attempts, window_started_at

**Assessment:** Server-only rate-limit table. No PII beyond the `key` field (which is email). **OK — service_role only.**

---

### public.admin_actions

- **RLS enabled:** YES
- **Policies:** NONE
- **Columns with PII:** admin_user_id (UUID), payload (JSONB, may contain participant data), ip_inet, user_agent, action, target_table/target_id

**Assessment:** Audit log. Must never be readable by ordinary authenticated users. Service_role only. **OK.**

---

### public.user_badges

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| Anyone can read badges | SELECT | `true` | — | Anyone sees all user-badge assignments including user_id | Review |

**Assessment:** `user_id` in this table is a UUID (not username/email). The linked `badge_definitions` table (RLS disabled, public data) contains only badge names/descriptions. Knowing that UUID X has badge Y is low-sensitivity if UUIDs are not otherwise linkable. However, the `profiles_public` view exposes `id = user_id`, so the UUID *is* linkable to a username. This creates a minor profile disclosure path (badge ownership → profile). **Accepted for now** — badge visibility is a social feature; flag for review if highly sensitive badges are added.

---

### public.calendar_event_reports

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| Anyone can create reports | INSERT | — | `true` | Anyone submits corrections | Accepted |

**Columns with PII:** `user_id` (nullable UUID), `note` (free text, may contain personal info), `source_url`.

**Missing SELECT policy:** There is no SELECT policy for anon or authenticated. Only `service_role` can read reports (for admin review). **This is correct behavior** — report reviewers use the admin UI which calls backend with service_role key. **OK.**

---

### public.website_feedback

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| anon_insert_feedback | INSERT | — | `true` | Anyone submits feedback | Accepted |
| service_select_feedback | SELECT | `true` | — | Only service_role reads | OK |
| service_update_feedback | UPDATE | `true` | — | Only service_role updates (status changes) | OK |

**Columns with PII:** `email` (optional), `message` (free text), `user_id` (nullable).

**Assessment:** Anon can insert their own feedback. No anon SELECT = users cannot read each other's submissions. Service_role = admin review only. **OK.**

---

### public.calendar_events

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| public_read | SELECT | `true` | — | Anyone reads all events incl. pending | Review |
| Anyone can submit pending events | INSERT | — | `status = 'pending'` | Anon can add events (pending only) | OK |

**Columns with PII:** None — event data only (name, date, city, distances, etc.).

**Assessment on public_read:** The USING clause is `true` with role `{public}`, meaning both anon and authenticated can read **all** rows, including `status = 'rejected'` events. Rejected events contain original scraped data (event names, URLs) and are not personal data. However, `pending` events visible to anon means anyone can enumerate scraper output before admin review. This is a minor data leak (not GDPR), but worth noting. **Accepted trade-off** — the calendar is a public feature; pending events contain no personal data.

---

### public.checkins

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| Public read | SELECT | `true` | — | Anyone reads all check-ins | REVIEW |
| Anon insert once | INSERT | — | dedup check on participant_id | One check-in per participant | OK |

**Columns with PII:** `participant_id` (UUID), `event_id`, `checked_in_at`, `created_at`.

**Assessment:** `participant_id` is a UUID. Via `participants_public` view, it links to first/last name. So anyone can determine who has checked in to an event by joining `checkins.participant_id` to `participants_public.id`. For a race event this is **publicly expected** (check-in status is shown on volunteer screens), but worth noting. No direct PII in this table. **Accepted — public feature.**

---

### public.checkin_documents

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| Public read | SELECT | `true` | — | Anyone reads document completion status | Accepted |
| Anon insert | INSERT | — | checkin must exist | Only valid checkin rows | OK |

**Columns:** `checkin_id` (UUID FK → checkins), `document_id`, `completed_at`, `completed_by` (text), `status`.

**Assessment:** `completed_by` may contain volunteer name or identifier string. Low sensitivity. No direct PII beyond FK chains. **Accepted — public flow.**

---

### public.event_favorites

- **RLS enabled:** YES
- **Policies:** NONE

**Columns:** `user_id` (UUID), `event_id`, `created_at`.

**Assessment:** RLS on, no policy = fully blocked to anon and authenticated. But this means the feature cannot work from the client. The backend must be inserting/reading via service_role. **Need to add user-scoped policies for this feature to work from the frontend.**

**Status:** TIGHTEN — add SELECT/INSERT/DELETE own-row policies. *Awaiting user confirmation.*

---

### public.event_notifications

- **RLS enabled:** YES
- **Policies:** NONE

**Columns:** `id`, `event_id`, `type`, `created_at` — **no user_id column**. This appears to be a system notification log, not per-user.

**Assessment:** No user_id = no user-scoped data. RLS with no policy = service_role only. **OK if this is an internal log.** If it needs to be read by authenticated users for "my notifications", the schema would need a user_id column first. **Deferred — schema unclear.**

---

### public.notification_preferences

- **RLS enabled:** YES
- **Policies:**

| Name | Operation | USING | WITH CHECK | Threat model | Verdict |
|---|---|---|---|---|---|
| Owner reads own notification prefs | SELECT | `user_id = auth.uid()` | — | User reads own prefs only | OK |

**Missing:** No INSERT or UPDATE policy. User cannot create or update their own prefs from the client unless done via service_role backend endpoint. **Likely intentional** — backend API handles writes. **OK.**

---

## SECURITY DEFINER functions analysis

These 10 functions are flagged by the advisor because Supabase auto-grants EXECUTE to anon/authenticated on new functions. The security model is:

| Function | Caller | Security model | Assessment |
|---|---|---|---|
| `check_checkin_pin(event_id, pin)` | anon (volunteer app) | PIN from `event_secrets` (service_role only table) | OK — PIN validates access |
| `verify_checkin_pin(event_id, pin)` | anon | Same | OK |
| `checkin_confirm(participant_id, pin, documents)` | anon | PIN-gated | OK |
| `checkin_confirm(participant_id, event_id, pin, documents)` | anon | PIN-gated | OK |
| `get_participant_admin(event_id, pin, participant_id)` | anon | PIN-gated | OK |
| `get_participant_for_checkin(participant_id)` | anon | UUID from SMS = auth token | OK |
| `search_participants_admin(event_id, pin, query)` | anon | PIN-gated | OK |
| `is_username_available(u)` | anon/authenticated | No sensitive data returned | OK |
| `search_clubs(q)` | anon/authenticated | No sensitive data returned | OK |
| `notify_calendar_event_changes()` | — | Trigger function, not callable via RPC meaningfully | Low risk |

**Verdict:** All callable-by-anon functions are either PIN-gated (check-in flow) or return non-sensitive data. No tightening required beyond documenting the accepted model.

---

## Actions taken

All four tightenings applied 2026-06-04 via `mcp__supabase__apply_migration`. Each migration is individually trackable in `supabase_migrations`.

| Migration name | Table(s) | What it did |
|---|---|---|
| `enable_rls_on_participants` | `participants` | Enabled RLS. No anon policy added — anon access via `participants_public` view (SECURITY DEFINER). rfid_epc no longer reachable by anon/authenticated. |
| `enable_rls_on_events` | `events` | Enabled RLS. Existing "anon read events" policy now active. |
| `enable_rls_on_categories` | `categories` | Enabled RLS. Existing "anon read categories" policy now active. |
| `enable_rls_on_results` | `results` | Enabled RLS. Existing "anon read results" policy now active. |
| `enable_rls_on_race_runs` | `race_runs` | Enabled RLS. Existing "anon read race_runs" policy now active. |
| `enable_rls_on_gate_crossings` | `gate_crossings` | Enabled RLS. Existing "anon read gate_crossings" policy now active. |
| `add_profiles_own_row_policies` | `profiles` | Added SELECT/UPDATE/INSERT own-row policies for `authenticated` role. Users can only read/write their own profile row. Anon goes through `profiles_public` view. |
| `add_event_favorites_own_row_policies` | `event_favorites` | Added SELECT/INSERT/DELETE own-row policies for `authenticated` role. Feature unblocked client-side. |

### Verification — T2 policies active

After enabling RLS on the five T2 tables, confirmed all pre-existing "anon read" policies are firing via `pg_policies` query. All five returned rows in `pg_policies` with `roles = {anon}` and `cmd = SELECT`.

---

## Open items / deferred

| Item | Reason deferred |
|---|---|
| `event_notifications` — no user_id column, policies unclear | Schema needs clarification before adding policies |
| `function_search_path_mutable` — 10 functions | Low practical risk; high remediation effort (recreate all functions with SET search_path). Deferred to a dedicated hardening pass. |
| `extension_in_public` — pg_trgm | Minor hygiene; moving requires recreating dependent indexes. Not GDPR-relevant. |
| RLS on 37 scraper/pipeline tables | No PII in scraper tables; backend (service_role) is the only writer/reader. Enabling RLS would require adding `USING (true)` policies to avoid breaking backend queries. Low-priority. |
| `public_bucket_allows_listing` (partner-logos) | Non-personal data, cosmetic issue. |
| `notification_preferences` — no INSERT/UPDATE policy | Backend API handles writes via service_role; this is likely intentional. |
| `user_badges` — public SELECT includes user_id | Minor; UUIDs not directly identifying without join. Flag for review if sensitive badges introduced. |
| `calendar_events` public_read shows pending/rejected rows | No PII; accepted trade-off for public calendar feature. |

---

## Calendar events anti-scrape gap (deferred)

**Concern raised by operator 2026-06-04:** `calendar_events` is a monetizable data asset. RLS-level protection cannot prevent scraping because anonymous SELECT access is required for the public kalendarz page to function (Kalendarz.jsx, Landing.jsx, /listy/* pages all query Supabase directly with the anon key).

**Why RLS alone doesn't solve this:**
- Removing anon SELECT on `calendar_events` would break the public site
- All `calendar_events` field values are already rendered in the public HTML, so they're scrapeable from the DOM regardless of API protection
- The Supabase anon API just makes scraping more convenient, not possible

**Real protection options (separate workstream):**
1. **Move public reads through an edge function with per-IP rate limiting.** Refactor Kalendarz/Landing/listy data layer to call a new `/functions/v1/public-calendar-events` endpoint instead of querying Supabase directly. Then drop anon SELECT on `calendar_events`. Add a request throttle. Estimated effort: 1–2 days, touches multiple frontend files + new edge function.
2. **Add Vercel WAF rules or Cloudflare in front.** Detect bot-like patterns (rate, user-agent, headless browser signatures) at infrastructure level. Doesn't require code changes but does require platform configuration.
3. **Accept the trade-off** and rely on the existing public exposure (which is the current state).

**Recommendation:** scope this as a follow-up project after the GDPR programme ships. Not blocking compliance.

---

## Sub-resource integrity (SRI) note

We do NOT use SRI on the Google Analytics gtag.js script because Google rotates the bundle contents without publishing stable SHA hashes. This is documented as an accepted trade-off — the primary XSS defense is React's automatic escaping plus the CSP `script-src` allowlist.

---

## Re-verification

- Date: 2026-06-04
- Method: re-ran `mcp__supabase__get_advisors` after applying all T1–T4 migrations
- Before: **97 lints** — 7 ERRORs (`policy_exists_rls_disabled` ×5 + `security_definer_view` ×2), 11 INFO (`rls_enabled_no_policy`), 43 `rls_disabled_in_public` ERRORs (counted within the 97 total), 20 WARN (security_definer functions), plus others
- After: **85 lints** — 39 ERRORs (`rls_disabled_in_public` ×37 scraper/pipeline tables + `security_definer_view` ×2), 10 INFO (`rls_enabled_no_policy`), no `policy_exists_rls_disabled`

**Delta confirmed:**
- `policy_exists_rls_disabled` — **resolved completely** (5 → 0). T2 migrations activated the dormant policies.
- `rls_disabled_in_public` — dropped by 6 (participants T1 + events/categories/results/race_runs/gate_crossings T2).
- `rls_enabled_no_policy` — dropped from 11 to 10 (profiles dropped out; event_favorites dropped out; both replaced by active policies). One new `rls_enabled_no_policy` may have appeared for `participants` since it now has RLS on with no anon policy — this is intentional.

**Remaining items and why they are not action items:**
- `rls_disabled_in_public` ×37 — all scraper/pipeline tables; no PII; deferred (see Open items)
- `security_definer_view` ×2 — `participants_public` and `profiles_public`; intentional, documented in SECURITY DEFINER analysis above
- `rls_enabled_no_policy` ×10 — server-only tables (admin_actions, auth_codes, auth_sessions, otp_throttle, event_secrets, geocode_cache, url_suggestions, pin_attempts) + event_notifications (schema unclear) + participants (intentional, view is the access path)
- `function_search_path_mutable` ×10 — code-quality nit, deferred
- `anon/authenticated_security_definer_function_executable` ×20 — accepted trade-off, PIN-gated or non-sensitive
- `auth_leaked_password_protection` ×1 — not applicable (magic-link/OTP only, no passwords)
- `extension_in_public` ×1 — pg_trgm, deferred
- `public_bucket_allows_listing` ×1 — partner-logos, non-personal
- `rls_policy_always_true` ×3 — calendar_event_reports, checkpoint_observations, website_feedback; all documented as accepted trade-offs above
