# GDPR Compliance Programme — Leszy.run

**Date:** 2026-06-03
**Branch:** `feat/auth-profiles-contributions-badges` (or split into a sibling `feat/gdpr-compliance`)
**Status:** Design

## Goal

Bring leszy.run into compliance with GDPR (Regulation (EU) 2016/679) and Polish UoŚUDE (Ustawa o świadczeniu usług drogą elektroniczną) for every data flow currently in production:

1. User accounts (custom auth + profiles + contributions + badges)
2. Race participants imported by event organizers
3. Race timing data (gate_events, gate_crossings, results)
4. SMS check-in flow
5. Scraped public event metadata (no personal data — see §6)
6. Web analytics (Google Analytics 4)

The end state is: every required public document exists, users can exercise their data subject rights through self-service, security controls satisfy Art. 32, and the operator has internal documentation (ROPA, breach runbook, DPIA) to demonstrate accountability under Art. 5(2).

## Scope decisions (locked-in 2026-06-03)

| Decision | Choice |
|---|---|
| Controller / processor model | **Leszy.run is sole controller** for ALL personal data in its database — both directly-registered users AND participants imported by event organizers. No DPAs needed with organizers; no joint controllership arrangement. Data subject requests handled exclusively by Leszy.run. |
| Account deletion | **Soft** — null PII in `profiles`, keep anonymized contribution counts and result rows |
| Re-registration after deletion | **Blocked.** The `auth.users.email` unique constraint stays claimed forever after soft delete. The same email can never sign up again. Operator-chosen "clean break" policy. |
| Anonymized results display | Shown as `Uczestnik anonimowy` with tooltip explaining the account was deleted (not a user request for anonymity) |
| Contact address for data subject requests | `lukasz@leszy.run` |
| Personal contact in JSON-LD (`index.html`) | **Keep as-is** — operator accepts the visibility |
| Automatic data retention purges | **Only** `gate_events` + `gate_crossings` (90 days post-race). All other personal data is kept until the user requests deletion. |
| Scrapers + personal data | Operator confirms scrapers extract **no** organizer personal data. DPIA-scrapers is **dropped**. Privacy policy will state this explicitly. |
| ROPA visibility | **Public** in this repository (`docs/gdpr/ropa.md`) |
| `profiles.city` field | **Kept** — no minimization |
| Profile DOB granularity | **Full date** (status quo — needed for age categories) |

## Out of scope (explicit non-goals)

- Auto-deletion of inactive accounts
- Auto-purge of `rejected` scraper rows or `consent_log`
- Replacing the personal email/phone in `index.html` JSON-LD
- Removing or year-only-reducing `date_of_birth`
- Removing `city` from profiles
- Scraper DPIA (no personal data processed by scrapers)
- A formal DPO appointment (org size doesn't trigger Art. 37 mandatory designation; operator acts as the contact person)
- Encrypted backups beyond what Supabase / Vercel already provide
- Anything outside the `leszy.run` web product (no mobile apps, no separate APIs)

## Architecture overview

The work is divided into **six workstreams** (A–F) that can largely proceed in parallel. Each workstream owns specific artifacts in the repo:

```
A. Public legal pages       → public/src/pages/, public/scripts/, public/index.html, vercel.json
B. Consent management       → public/src/components/CookieBanner.jsx, supabase/migrations/, public/src/pages/Onboarding.jsx
C. Data subject rights      → supabase/functions/export-my-data/, supabase/functions/delete-my-account/,
                              public/src/pages/Profil.jsx, packages/ui/, backend/src/db/schema.js
D. Retention                → supabase/migrations/ (pg_cron job), text in privacy policy
E. Security hardening       → vercel.json, supabase/functions/auth-request-code/, supabase/migrations/,
                              supabase/functions/get-profile-data/, docs/gdpr/rls-audit.md
F. Internal documentation   → docs/gdpr/ (ROPA, breach response, DPIA-participants, DPA checklist)
```

Each piece is described below with concrete files, schema changes, and acceptance criteria. The implementation plan that follows this spec will sequence these into commits.

---

## §1. Workstream A — Public legal pages

### A1. Privacy Policy — `/polityka-prywatnosci`

New React page at [public/src/pages/PolitykaPrywatnosci.jsx](public/src/pages/PolitykaPrywatnosci.jsx), routed in [public/src/App.jsx](public/src/App.jsx).

Pre-rendered for SEO via a new `public/scripts/generate-legal-pages.js` script (mirrors existing `generate-landing-pages.js`). The generated `dist/polityka-prywatnosci/index.html` carries:

- `<title>` and `<meta name="description">`
- Canonical URL `https://www.leszy.run/polityka-prywatnosci`
- JSON-LD `WebPage` with `inLanguage: pl-PL`
- Pre-rendered body content (so crawlers see the policy without running JS)

Content sections (Polish, formal "Pan/Pani" register):

1. **Administrator danych osobowych** — Łukasz Górnicki, prowadzący serwis Leszy.run, kontakt: `lukasz@leszy.run`. Polityka wyraźnie stwierdza: **Leszy.run jest administratorem danych osobowych przetwarzanych w serwisie — niezależnie od tego, czy zostały podane bezpośrednio przy rejestracji konta, czy pozyskane od organizatora biegu przy imporcie listy startowej.** Organizator biegu pozostaje administratorem danych w swoim własnym systemie zapisów, lecz po przekazaniu danych do Leszy.run administratorem tych danych w naszej bazie jest wyłącznie Leszy.run. Wszelkie wnioski (dostęp, usunięcie, sprostowanie, sprzeciw) należy kierować do `lukasz@leszy.run`.
2. **Zakres przetwarzanych danych** — categorized list:
   - Konto użytkownika: email, username, display_name, phone (opcjonalnie), DOB, gender, city, voivodeship, club
   - Uczestnik biegu (zaimportowany przez organizatora): name, surname, bib, category, RFID tag, phone (opcjonalnie do SMS check-in), email (opcjonalnie)
   - Pomiary czasu: gate_events, gate_crossings, checkpoint_observations, results
   - Check-in: zgoda na regulamin, znaczniki czasowe, podpis cyfrowy gdy dotyczy
   - Analityka: pliki cookie GA4 wyłącznie po wyrażeniu zgody
3. **Cele i podstawy prawne** — explicit Art. 6 mapping per category, with Leszy.run as controller throughout:
   - Konto użytkownika: Art. 6(1)(b) — wykonanie umowy o świadczenie usług elektronicznych zawartej z użytkownikiem
   - Uczestnictwo w biegu (dane importowane od organizatora): Art. 6(1)(f) — uzasadniony interes Leszy.run polegający na świadczeniu usługi pomiaru czasu i prowadzeniu archiwum sportowego. Uczestnik może w każdej chwili wnieść sprzeciw, kontaktując się pod `lukasz@leszy.run` — wówczas dane zostaną zanonimizowane.
   - Pomiary czasu (gate_events, crossings): Art. 6(1)(f) — uzasadniony interes (zapewnienie integralności i weryfikowalności wyników)
   - Wyniki publiczne i archiwum: Art. 6(1)(f) — uzasadniony interes (archiwum sportowe, transparentność wyników biegów)
   - SMS check-in: Art. 6(1)(b) — wykonanie umowy / zgoda implicit przez podanie numeru telefonu organizatorowi
   - Analityka: Art. 6(1)(a) — zgoda wyrażana w banerze cookie
4. **Okres przechowywania danych** — concrete retention per category:
   - Dane konta: bezterminowo, aż do żądania usunięcia
   - gate_events / gate_crossings: 90 dni po zakończeniu biegu (purgowane automatycznie)
   - Wyniki biegu: bezterminowo (archiwum), z prawem do anonimizacji po usunięciu konta
   - consent_log: bezterminowo (dowód zgody)
   - Logi analityczne GA4: zgodnie z ustawieniami Google (konfigurowane na 14 miesięcy)
5. **Odbiorcy danych** — link to `/podmioty-przetwarzajace` listing every processor
6. **Prawa osoby, której dane dotyczą** — Art. 15–22 enumerated in Polish:
   - dostęp ("Pobierz moje dane" w `/profil`)
   - sprostowanie (edycja profilu)
   - usunięcie ("Usuń konto" w `/profil`)
   - ograniczenie przetwarzania (`lukasz@leszy.run`)
   - przenoszenie (eksport JSON)
   - sprzeciw wobec uzasadnionego interesu (`lukasz@leszy.run`)
   - cofnięcie zgody (cookie preferences, w każdej chwili)
7. **Prawo wniesienia skargi do UODO** — z linkiem do `https://uodo.gov.pl/pl/p/skargi`
8. **Pliki cookie** — które, kategorie (niezbędne / analityczne), jak zarządzać
9. **Dane scrapowane** — explicit: "Z publicznie dostępnych stron internetowych organizatorów biegów agregujemy wyłącznie informacje o wydarzeniach (nazwa, data, miejsce, dystanse, link do zapisów). Nie przetwarzamy danych osobowych organizatorów ani uczestników z tych źródeł."
10. **Zmiany polityki** — wersja + data, link do GitHuba dla historii zmian
11. **Kontakt** — `lukasz@leszy.run`

Version tracked in a constant `POLICY_VERSION` (e.g. `"2026-06-03"`) used by the consent log.

### A2. English mirror — `/privacy-policy`

Translated copy of A1, same structure, footer language toggle. Both pages reference the same `POLICY_VERSION`.

### A3. Terms of Service — `/regulamin`

Required under UoŚUDE for any account-creating service in Poland. Covers:

- Definitions (usługa, użytkownik, konto, biegacz, organizator)
- Warunki świadczenia usług elektronicznych
- Rejestracja konta i wymagania techniczne
- Zasady korzystania (zakazana zawartość)
- Reklamacje (28-dniowy termin)
- Rozwiązanie umowy (usunięcie konta)
- Prawo właściwe i sąd właściwy
- Postanowienia końcowe (data wejścia w życie)

Pre-rendered like A1. Linked from Onboarding consent checkbox.

### A4. Processor Inventory — `/podmioty-przetwarzajace`

Public page listing each third party that receives user data, with their DPA link. Pre-rendered.

| Procesor | Cel | DPA |
|---|---|---|
| Supabase, Inc. (USA, EU SCC) | Baza danych, autentykacja, Edge Functions, Storage | https://supabase.com/legal/dpa |
| Vercel, Inc. (USA, EU SCC) | Hosting frontendu, CDN, serverless funkcje | https://vercel.com/legal/dpa |
| SMSAPI sp. z o.o. (Polska) | Wysyłka wiadomości SMS check-in | (link do DPA z panelu SMSAPI) |
| Twilio Inc. / SendGrid (USA, EU SCC) | Wysyłka wiadomości email | https://www.twilio.com/legal/data-protection-addendum |
| Google Ireland Ltd. (Irlandia) | Analityka GA4 (tylko po wyrażeniu zgody) | https://support.google.com/analytics/answer/9012600 |
| Google Fonts (CDN) | Renderowanie czcionek | Acceptable use (no personal data transfer) |

Each row also says **where data is stored** (region) and **what data leaves Poland**.

### A5. Footer + cookie management UI

A small `Footer.jsx` component added to `public/src/components/` and rendered in `App.jsx`. Visible on every page. Links:

- Polityka prywatności
- Regulamin
- Podmioty przetwarzające
- "Zarządzaj cookies" (re-opens the cookie banner via a custom event)

The "Zarządzaj cookies" link dispatches a `'leszy:cookies:open'` window event that the `CookieBanner` component listens for. This satisfies Art. 7(3) — withdraw consent as easily as giving it.

### Acceptance for Workstream A

- All four pages load at their canonical URLs in `npx vite preview` and `vercel build` outputs
- `curl -s https://localhost.../polityka-prywatnosci` (during smoke test) shows pre-rendered HTML body, not just `<div id="root"></div>`
- Footer renders on every page
- "Zarządzaj cookies" re-opens the banner

---

## §2. Workstream B — Consent management

### B1. Cookie banner upgrade — [public/src/components/CookieBanner.jsx](public/src/components/CookieBanner.jsx)

Current state: stores `'accepted' | 'rejected'` in `localStorage` under key `leszy-cookie-consent`.

New shape:

```js
{
  decision: 'accepted' | 'rejected',
  timestamp: '2026-06-03T14:32:11.412Z',
  policyVersion: '2026-06-03',
  userAgent: navigator.userAgent
}
```

Migration: on first load, if `localStorage` contains the old string, wrap it into the new object with `policyVersion: 'pre-2026-06-03'` so the consent stays honored but is flagged as needing re-confirmation if `POLICY_VERSION` later changes.

Behavior changes:

- Listen for `'leszy:cookies:open'` event → re-show the banner with current selection pre-highlighted
- When policy version is newer than the recorded `policyVersion`, re-show the banner automatically with a "Aktualizacja polityki" notice
- Reject and Accept both write the full audit object; today, reject also writes (so we have proof) — same in the new version
- The reject case still clears GA cookies (current behavior preserved)

### B2. Server-side consent log — `consent_log` Supabase table

For logged-in users, mirror every consent decision into Supabase so we have a tamper-resistant record. Anon visitors stay in `localStorage` only.

```sql
create table public.consent_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('accepted','rejected','withdrawn')),
  policy_version text not null,
  ip_inet inet,                     -- captured at edge function, never written from client
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.consent_log enable row level security;

-- Anyone authenticated can insert their own consent (via edge function)
create policy "consent_log: insert own"
  on public.consent_log for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can read their own consent history (for /eksport-danych)
create policy "consent_log: select own"
  on public.consent_log for select
  to authenticated
  using (auth.uid() = user_id);

-- No update, no delete from clients — append-only
```

Writes happen via a new edge function `supabase/functions/log-consent/index.js` which captures the IP from the request headers and inserts on behalf of the user. The IP is stored as `inet` for size + privacy (no GeoIP lookup, no enrichment).

### B3. Onboarding consent checkbox — [public/src/pages/Onboarding.jsx](public/src/pages/Onboarding.jsx)

Add a required checkbox before account activation:

> ☐ Akceptuję [Regulamin](/regulamin) oraz [Politykę prywatności](/polityka-prywatnosci) serwisu Leszy.run.

(Single combined checkbox — Polish UoŚUDE allows bundling acceptance of regulamin + privacy policy as long as both are linked. We do NOT bundle the GA cookie consent here; that stays in the banner and is genuinely separate.)

On submit, before completing onboarding, the client calls `log-consent` with `decision: 'accepted'` and the current `POLICY_VERSION`.

### Acceptance for Workstream B

- `localStorage` after accept contains the full audit object
- After login + accept, `consent_log` has a row with `user_id = current user`
- Clicking "Zarządzaj cookies" in the footer re-opens the banner
- Bumping `POLICY_VERSION` to a newer value re-prompts on next visit
- Onboarding refuses to complete without the regulamin/policy checkbox

---

## §3. Workstream C — Data subject rights

### C1. Eksport moich danych — `supabase/functions/export-my-data/index.js`

New edge function. Authenticated request. Returns a JSON download containing every row tied to the user:

```json
{
  "exported_at": "2026-06-03T14:32:11.412Z",
  "policy_version_at_export": "2026-06-03",
  "account": { /* profiles row */ },
  "contributions": [ /* all contributions */ ],
  "badges": [ /* all badges */ ],
  "consent_log": [ /* every consent decision */ ],
  "results": [ /* every race where this user.email matches a participant.email */ ]
}
```

Streaming or single response (JSON file fits in memory for any realistic user). Response headers `Content-Disposition: attachment; filename="leszy-run-dane-USER_UUID-YYYY-MM-DD.json"`.

### C2. Usuń moje konto — `supabase/functions/delete-my-account/index.js`

New edge function. Two-step flow:

1. **Step 1 — request:** Authenticated user calls `delete-my-account` with `{ action: 'request' }`. Function emails an OTP (via existing `auth-request-code` infrastructure) with subject "Potwierdź usunięcie konta na Leszy.run".
2. **Step 2 — confirm:** User submits the OTP via `{ action: 'confirm', code: '...' }`. On valid OTP, the function captures the user's email (needed to find linked participants) and then performs the **soft delete** in a single transaction:

```sql
-- Inside a transaction in the edge function:
-- 1. Capture email BEFORE nulling it on profiles
with snapshot as (
  select id, email from public.profiles where id = :user_id
),
-- 2. Anonymize local participants matched on that email
anon_p as (
  update public.participants p
  set first_name = 'Uczestnik',
      last_name = 'anonimowy',
      phone = null,
      email = null,
      deleted_at = now()
  from snapshot s
  where p.email = s.email
  returning p.id
)
-- 3. Soft-delete the profile
update public.profiles p
set email = null,
    username = 'usuniety-' || substr(p.id::text, 1, 8),
    display_name = 'Uczestnik anonimowy',
    phone = null,
    date_of_birth = null,
    gender = null,
    city = null,
    voivodeship = null,
    club_id = null,
    deleted_at = now()
from snapshot s
where p.id = s.id;

-- 4. After commit: permanently ban the auth user.
-- The auth.users.email is intentionally NOT rotated — the email stays
-- claimed on auth.users so the address can never be re-used to sign up
-- again. This is the deliberate "clean break" policy (see Risks section).
-- Done via Supabase admin SDK:
--   await supabaseAdmin.auth.admin.updateUserById(userId, {
--     ban_duration: '876000h',  // ~100 years, effectively permanent
--   })
```

(The function uses the `service_role` Supabase client to run the CTE + update via `rpc()` or sequential statements; the SQL above shows the intent. Note `participants.email` exists in the local Drizzle schema — confirmed at [backend/src/db/schema.js:44](backend/src/db/schema.js#L44). The unique email constraint on `auth.users` prevents re-registration with the same address — this is the intended behavior.)

(`deleted_at` columns added in Workstream C migration — see C5.)

After soft delete, the auth session is invalidated and the function returns `{ deleted: true }`. The frontend redirects to the homepage with a confirmation toast.

### C3. UI in /profil — "Pobierz moje dane" + "Usuń konto"

New section at the bottom of [public/src/pages/Profil.jsx](public/src/pages/Profil.jsx), styled per OVERDRIVE theme:

- "Pobierz moje dane" → calls `export-my-data`, triggers browser download
- "Usuń konto" → opens a modal with explanation of what soft delete means:
  > **Co się stanie po usunięciu konta?**
  > - Twój profil zostanie usunięty, a wszystkie dane osobowe (imię, telefon, data urodzenia, lokalizacja) wymazane.
  > - Twoje wyniki w archiwach biegów pozostaną widoczne, ale podpisane jako **Uczestnik anonimowy** — z informacją w dymku, że konto zostało usunięte.
  > - **Tego adresu email nie da się już ponownie wykorzystać do rejestracji w Leszy.run** — to celowe, by usunięcie było ostateczne.
  > - Tej operacji nie da się cofnąć. Aby potwierdzić, wyślemy Ci kod OTP na email.

  Confirmation button triggers Step 1 of C2.

### C4. Anonymous results display — `packages/ui/`

In every results-rendering component in `packages/ui/`, when a result row has a linked `participant.deleted_at IS NOT NULL` or `profile.deleted_at IS NOT NULL`, render:

- Name as `Uczestnik anonimowy`
- Wrapped in a `<Tooltip>` (existing shadcn Tooltip primitive) with text:
  > Konto użytkownika zostało usunięte. Wynik pozostaje jako część archiwum biegu.

This applies to: [packages/ui/src/](packages/ui/src/) result components, [public/src/pages/Results.jsx](public/src/pages/Results.jsx), `EventPage.jsx`, `CategorySection.jsx`, podium views, and any public profile views.

### C5. Schema changes — `participants` + `profiles` get `deleted_at`

Drizzle migration + matching Supabase migration:

```sql
-- Local Drizzle migration (backend/src/db/migrations/NNNN_soft_delete.sql)
alter table participants add column deleted_at timestamptz;

-- Supabase migration (separate file in supabase/migrations/)
alter table public.profiles add column deleted_at timestamptz;
alter table public.participants add column deleted_at timestamptz;
```

Both `participants` writes via the existing sync triggers respect `deleted_at` automatically (the row still syncs; downstream consumers filter on `deleted_at IS NULL` for active queries and ignore the filter for archive views).

### Acceptance for Workstream C

- Logged-in user can download a JSON file containing all their data
- "Usuń konto" → OTP email → confirm → profile fields nulled, `deleted_at` set, session invalidated
- Public results pages render `Uczestnik anonimowy` + tooltip for soft-deleted users
- Auth flow refuses login for soft-deleted accounts (`banned_until = infinity`)
- Re-registering with the same email creates a NEW account (no automatic recovery — operator decision: clean break)

---

## §4. Workstream D — Retention

### D1. Automatic purge of gate_events + gate_crossings

Supabase `pg_cron` job that runs daily at 03:00 UTC:

```sql
-- Migration: supabase/migrations/NNNN_retention_purge.sql
select cron.schedule(
  'purge-rfid-logs',
  '0 3 * * *',
  $$
  delete from public.gate_events
  where race_run_id in (
    select id from public.race_runs
    where status in ('finished','cancelled')
      and ended_at < now() - interval '90 days'
  );

  delete from public.gate_crossings
  where race_run_id in (
    select id from public.race_runs
    where status in ('finished','cancelled')
      and ended_at < now() - interval '90 days'
  );
  $$
);
```

The matching local DB does the same via a backend cron entry in `scheduler/` (or simpler: a one-shot daily script that calls into the backend).

**Why 90 days:** long enough that any disputed race result can be audited end-to-end against raw RFID, short enough that we're not warehousing identifiable timing data forever. The `results` table stays untouched — `results` are the durable archive.

(If you want a different TTL, change before implementation. Otherwise we ship 90.)

### D2. Retention policy text in privacy policy

§4 of A1 already enumerates this. No additional code; this is a documentation alignment item.

### Acceptance for Workstream D

- `pg_cron` job visible in Supabase dashboard
- Manual dry-run on a test event confirms it purges raw events but leaves `results` intact
- Backend matching purge runs daily without errors

---

## §5. Workstream E — Security hardening (Art. 32)

### E1. Security headers in `vercel.json`

Add a `headers` array applying to all routes:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://www.google-analytics.com https://region1.google-analytics.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self';" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()" }
      ]
    }
  ]
}
```

CSP includes `'unsafe-inline'` for scripts and styles because the app uses inline theme-flicker prevention and Tailwind-generated styles; we accept this trade-off (XSS protection via React's escaping is the primary defense). `frame-ancestors 'none'` blocks clickjacking.

**SRI on GA:** intentionally NOT added. Google rotates `gtag.js` content without publishing stable SHA hashes; SRI would brick analytics on every Google deploy. Documented as a known trade-off in [docs/gdpr/rls-audit.md](docs/gdpr/rls-audit.md).

### E2. OTP rate limiting on auth-request-code

Add a new Supabase table:

```sql
create table public.otp_throttle (
  key text primary key,                       -- 'email:foo@bar.com' or 'ip:1.2.3.4'
  attempts integer not null default 0,
  window_started_at timestamptz not null default now()
);
```

Edge function logic: before issuing an OTP, atomically increment + check. Limits:

- Per email: **5 requests per 15 minutes**
- Per IP: **20 requests per 15 minutes** (allows shared NAT)

Both windows expire automatically — if `window_started_at` is older than 15 min, the row resets. On limit hit, return `429` with `Retry-After` header.

This stops two attacks:
1. **Email spam / cost amplification** (each OTP costs us a SendGrid send)
2. **User enumeration** — currently an attacker can probe whether `foo@bar.com` has an account by watching response times; rate limiting + uniform response shape mitigates

### E3. Admin audit log — `admin_actions` table

**Important context:** the project's admin gate is currently an env-var allow-list (`ADMIN_USER_IDS`) checked inside admin edge functions, e.g. [supabase/functions/admin-review-contribution/index.js:26-27](supabase/functions/admin-review-contribution/index.js#L26-L27). There is no `profiles.role` column. This work does NOT migrate that gating into a DB column — we keep the env-var approach and the audit table is written from the server side only.

```sql
create table public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id),
  action text not null,                       -- 'delete_calendar_event' | 'merge_clubs' | 'reject_event' | etc.
  target_table text,
  target_id text,
  payload jsonb,
  ip_inet inet,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.admin_actions enable row level security;

-- No policies for anon or authenticated → all client access denied by default.
-- Inserts happen exclusively via the service_role key from edge functions or
-- backend Fastify routes that have already passed the ADMIN_USER_IDS check.
-- service_role bypasses RLS, so no insert policy is needed.

-- For now there is no admin-facing UI to read this log; when one is added later,
-- it will be a backend endpoint guarded by ADMIN_USER_IDS that reads with service_role.
-- No SELECT policy is exposed to clients.
```

A helper `logAdminAction(supabaseAdmin, { userId, action, target, payload, req })` is added to `supabase/functions/_shared/admin-audit.js` and called from every admin-write edge function (`admin-review-contribution`, plus any future club merge / event delete endpoints). The helper extracts `x-forwarded-for` and `user-agent` from the request and inserts using the passed service_role client.

The backend admin routes that already exist (Fastify) get a similar helper (`backend/src/lib/adminAudit.js`) and write to the same Supabase table via the existing service-role client used by the sync worker.

### E4. Public profile exposure audit — `get-profile-data`

Audit task: read [supabase/functions/get-profile-data/index.js](supabase/functions/get-profile-data/index.js) and verify what's returned to an **unauthenticated** caller vs. the **profile owner**.

Required behavior (will fix if not already):

| Field | Anon caller | Owner |
|---|---|---|
| username | ✅ | ✅ |
| display_name | ✅ | ✅ |
| club name | ✅ | ✅ |
| voivodeship | ✅ | ✅ |
| city | ❌ | ✅ |
| date_of_birth | ❌ | ✅ |
| gender | ❌ | ✅ |
| phone | ❌ | ✅ |
| email | ❌ | ✅ |
| contributions (public ones) | ✅ | ✅ |
| badges | ✅ | ✅ |

The function returns a projection based on `auth.uid() === target.id`. Findings + fixes documented in [docs/gdpr/profile-exposure.md](docs/gdpr/profile-exposure.md).

### E5. Supabase RLS audit

Run `mcp__supabase__get_advisors` for `type: 'security'`. For every table, document:

- Which policies are defined
- What `using` and `with check` express
- Who the threat actor is
- Whether the policy holds against that actor

Output: [docs/gdpr/rls-audit.md](docs/gdpr/rls-audit.md). Tighten any policies found to be permissive (especially `SELECT` policies on tables with PII).

### Acceptance for Workstream E

- `curl -sI https://www.leszy.run/` returns all six headers; CSP doesn't break GA or Supabase
- 6th OTP request to same email within 15min returns 429
- Every admin write produces an `admin_actions` row
- Anon `get-profile-data` doesn't leak DOB / phone / email / city
- `mcp__supabase__get_advisors` security report has no unresolved warnings
- `docs/gdpr/rls-audit.md` exists, documents every PII table

---

## §6. Workstream F — Internal documentation

### F1. ROPA — `docs/gdpr/ropa.md` (PUBLIC)

Rejestr Czynności Przetwarzania per Art. 30. Format: one section per processing activity. Required fields per activity:

- Nazwa czynności
- Cel
- Podstawa prawna (Art. 6 / Art. 9)
- Kategorie danych
- Kategorie osób, których dane dotyczą
- Odbiorcy (procesorzy)
- Transfery poza EOG (jeśli dotyczy) + zabezpieczenia (SCC)
- Okres przechowywania
- Środki bezpieczeństwa
- Data ostatniej aktualizacji

**Role:** Leszy.run / Łukasz Górnicki is the **sole controller (administrator danych osobowych)** for every processing activity below. There are no joint controllerships, no processor relationships with organizers. Organizers act as data *sources* — the controllership transfers to Leszy.run on import. This is stated explicitly in the ROPA header.

Processing activities to document:

1. **Rejestracja i prowadzenie kont użytkowników** (custom auth + profile) — source: direct registration
2. **Pomiar czasu w biegach** (race participants, gate_events, results) — source: organizer-supplied participant list, RFID hardware
3. **SMS check-in** (phone numbers, message logs) — source: participant import + SMS gateway
4. **Wkłady społecznościowe** (contributions, badges) — source: user-submitted content
5. **Agregacja kalendarza biegów** (scrapery — bez danych osobowych, ale wpisane dla kompletności)
6. **Analityka strony WWW** (Google Analytics 4) — source: visitor browsers, basis = consent
7. **Komunikacja transakcyjna** (emaile OTP, powiadomienia) — source: account email

### F2. Breach response runbook — `docs/gdpr/breach-response.md` (PUBLIC)

Step-by-step internal playbook. Sections:

1. **Definicja naruszenia** — przykłady (wyciek bazy, dostęp osoby trzeciej, utrata urządzenia)
2. **Wykrycie i triage** — kto eskaluje, w jaki sposób, czas reakcji
3. **Ocena ryzyka** — kryteria: rodzaj danych, liczba osób, prawdopodobieństwo szkody
4. **Decyzja o notyfikacji UODO** — kiedy wymagana (Art. 33), kiedy nie (niskie ryzyko)
5. **Zegar 72h** — start, zatrzymanie, dokumentacja
6. **Notyfikacja UODO** — szablon (jakie pola w formularzu UODO), kontakt
7. **Notyfikacja osób, których dane dotyczą** (Art. 34) — kiedy wymagana, szablon w PL/EN
8. **Mitigacja** — odcięcie dostępu, rotacja sekretów, audyt logów
9. **Post-mortem** — szablon: co się stało, jak wykryto, jak naprawiono, co się zmieni
10. **Aktualizacja ROPA i polityki** po incydencie

### F3. DPIA — `docs/gdpr/dpia-participants.md` (PUBLIC)

Data Protection Impact Assessment dla danych uczestników biegów. Wymagana wg Art. 35 ponieważ:

- Przetwarzamy dane dzieci (events with `is_kids = true`)
- Łączymy dane identyfikacyjne (imię, DOB, telefon) z danymi lokalizacyjno-czasowymi (gate_events)
- Skala — setki uczestników na bieg, dziesiątki biegów rocznie

Sekcje DPIA:

1. **Opis przetwarzania** — co, dla kogo, w jakim celu
2. **Konieczność i proporcjonalność** — dlaczego każde pole jest niezbędne; alternatywy odrzucone i dlaczego
3. **Identyfikacja ryzyk** — np. wyciek bazy → ujawnienie miejsca pobytu dziecka w określonym czasie; ujawnienie czasu biegu → wnioskowanie o stanie zdrowia
4. **Środki mitygacji** — szyfrowanie at-rest (Supabase), RLS, retencja, kontrola dostępu, audit log, OTP rate limit, CSP
5. **Pozostałe ryzyko po mitygacji** — niskie, akceptowalne
6. **Konsultacja z osobami, których dane dotyczą** — N/A, ale otwarty kanał kontaktu
7. **Decyzja i podpis** — data, podpis operatora
8. **Plan przeglądu** — co rok lub po istotnej zmianie

### F4. DPA checklist — `docs/gdpr/dpa-checklist.md` (PRIVATE — gitignored)

Lista czynności do wykonania przez operatora poza kodem:

- [ ] Założyć email `lukasz@leszy.run` (jeśli jeszcze nie ma)
- [ ] Zaakceptować DPA w panelu Supabase
- [ ] Zaakceptować DPA w panelu Vercel
- [ ] Zażądać i podpisać DPA z SMSAPI sp. z o.o.
- [ ] Skonfigurować retencję w GA4 na 14 miesięcy
- [ ] Zaakceptować Twilio MSA / SendGrid DPA
- [ ] Skonfigurować GA4 do anonimizacji IP (default w GA4, ale potwierdzić)
- [ ] Włączyć Google Signals = OFF (brak demograficznych jeśli niepotrzebne)
- [ ] Weryfikować dostępność `lukasz@leszy.run` co najmniej raz na tydzień (skrzynka kontaktowa dla wniosków)

**Add `docs/gdpr/dpa-checklist.md` to `.gitignore`** — this file tracks operator-only actions and shouldn't be public.

### Acceptance for Workstream F

- All four files exist in `docs/gdpr/`
- ROPA covers all seven processing activities listed
- DPA checklist is git-ignored (`grep dpa-checklist .gitignore` returns a match)
- Breach runbook has UODO contact info filled in (uodo.gov.pl/pl/p/kontakt)

---

## Migration / rollout sequence

The implementation plan (next document) will sequence these into commits. Sketch of the order:

1. **F first** (docs/gdpr/ — text only, no risk) — gives us the canonical content that feeds Workstream A
2. **A second** (legal pages — needed before we can ask users for fresh consent)
3. **B third** (consent — once pages exist, banner can link to them)
4. **C5 fourth** (schema migrations — small, isolated, blocks C1/C2)
5. **C1–C4 fifth** (export, delete, UI, anonymization rendering)
6. **D sixth** (retention cron — independent, low-risk)
7. **E last** (security hardening — CSP needs careful testing because it can break the site if misconfigured)

Each commit is small, reversible, and the spec's acceptance criteria gate each merge.

## Risks + open questions

- **CSP breaking the site** — mitigation: deploy first in `Content-Security-Policy-Report-Only` mode for a week, monitor reports, then enforce.
- **Soft delete + re-registration with same email** — intentionally blocked. `auth.users.email` is NOT rotated during soft delete, so the unique constraint keeps the address claimed forever. Once a user deletes their account, the same email address can never sign up again on leszy.run. The deletion modal and the privacy policy will state this explicitly so users understand the trade-off before confirming. Operator rationale: deletion should be a clean, final break — re-registration with the same email would create the impression of account "recovery" that isn't there.
- **Sync trigger interaction with `deleted_at`** — the existing `synced_at = null` trigger fires on any update, including the soft-delete update. Soft delete should still sync to Supabase. Verified consistent.
- **Anonymized name in `packages/ui/`** — there's a CLAUDE.md rule not to duplicate result-rendering logic. The anonymization check is added to the shared `estimatePositions` / result-rendering helpers, not the consumers.
- **GA4 retention 14m vs. our 90d gate_events** — different scopes, not a contradiction. GA retention applies to Google's copy of analytics events; ours applies to RFID logs. Policy text will distinguish.
- **`lukasz@leszy.run` alias** — assumed to be created by the operator before/around the time A1 ships. If it doesn't exist when the policy goes live, that's a Polish-law problem (contact address must be reachable). The DPA checklist's first item is this.

## Definition of done

The full programme is complete when:

1. All four public pages live and pre-rendered with correct JSON-LD
2. Cookie banner with audit trail + footer "Zarządzaj cookies" working in production
3. Logged-in user can export their data + delete their account end-to-end
4. Anonymized results render correctly across all UI surfaces
5. `gate_events` and `gate_crossings` are purged by daily cron
6. All six security headers active in production with no broken functionality
7. OTP rate limit, admin audit log, RLS audit, profile exposure fixes shipped
8. ROPA, breach runbook, DPIA, DPA checklist exist in `docs/gdpr/`
9. Operator-side items in DPA checklist tracked separately (not blocking code merge)
