---
name: registration-operator
description: Use when the LeszyRun operator asks about online race registration (zapisy) for clubs — "who is on the waitlist", "which clubs have zapisy", "has <club> accepted the agreement", "are payout details in", "enable / switch on zapisy for <club>", "disable <club>", "new agreement version". Covers the read-only status queries, the confirmed one-row enable/disable write with its admin_actions audit row, and the PR procedure for a new organizer agreement version.
---

# Registration operator

The operator runs these tasks from their own terminal against **production
Supabase**. Reads are free. Every write changes who can sell race entries and
take money, so it is one row, filtered by id, after an explicit "tak".

## This file is public

The repository is public. This file holds **no secrets, no real club data, no
emails, no IP addresses and no Tailscale addresses**, and nothing you add to it
may either. Every query below is a template: `<CLUB_ID>`, `<SLUG>` and the
like are filled in at run time, in the terminal, never in this file.

## Hard rules

1. **Reaching production.** Prefer the MCP supabase tools (`execute_sql` for
   the SQL below) when they are authenticated. Otherwise use PostgREST with
   curl, reading `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the main
   checkout's `.env` at `/Users/derberg/Documents/GitHub/BeepBeep/.env`
   (worktrees have no `.env`; never copy or delete it):
   ```bash
   set -a; . /Users/derberg/Documents/GitHub/BeepBeep/.env; set +a
   AUTH=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
   ```
   **Never print, echo, log or write the key**, and never paste its value into
   a command line, a script file or a file of any kind. Reference it only as
   `$SUPABASE_SERVICE_ROLE_KEY`.
2. **Reads are GET only** and need no confirmation.
3. **Every write follows CLAUDE.md "Database write safety"**: state exactly
   which table, which row (by id), which column and which value change, state
   the impact, and wait for the operator's explicit yes ("tak"). One row per
   write, filtered by `id=eq.<id>`, never by slug or name.
4. **Never DELETE** from `clubs`, `registration_waitlist`,
   `organizer_agreements`, `club_payout_details`, `club_payout_history`,
   `registration_settings`, `organizer_actions` or `admin_actions`. They are
   history or evidence of a contract.
5. **Never output** a full IBAN, a NIP, a KRS, a postal address, a legal name
   from payout details, a personal email or an IP address. Identify people by
   `profiles.username` only. Do not select columns you must not show
   (`nip`, `krs`, `address`, `legal_name`, `ip`, `user_agent`,
   `profiles.email`, `club_payout_history.old`/`new`): a value never fetched
   cannot leak.
6. **Never edit an `organizer_agreements` row.** An acceptance is evidence of
   a signed contract. A new text gets a new version (task 5).

Columns used below, all checked against `supabase/migrations/`:
`20261029100000_registration_foundation.sql` (registration tables,
`clubs.registration_enabled`), `20261029100100_club_payout_rpc.sql`
(`save_club_payout`), `20260717062635_teams_clubs_phase_a.sql`
(`clubs.owner_id`, `clubs.slug`, `club_members`),
`20260723063325_club_lifecycle_and_slug_history.sql` (`club_members.left_at`,
status values) and the baseline `20260717053838_remote_schema.sql`
(`clubs.id/name`, `profiles.username`, `admin_actions`). If a migration later
changes one of them, re-check before running.

## 1. Waitlist (read-only)

Clubs that asked to be switched on and are not enabled yet, oldest first.
"Active members" counts `club_members.status = 'active'` (left and removed
members keep their row with status `left`/`removed`).

```sql
SELECT c.name, c.slug, w.created_at, p.username AS requested_by,
       (SELECT count(*) FROM club_members m
         WHERE m.club_id = c.id AND m.status = 'active') AS active_members
FROM registration_waitlist w
JOIN clubs c ON c.id = w.club_id
LEFT JOIN profiles p ON p.id = w.requested_by
WHERE c.registration_enabled = false
ORDER BY w.created_at;
```

```bash
curl -s "$SUPABASE_URL/rest/v1/registration_waitlist?select=created_at,clubs!inner(id,name,slug,registration_enabled,club_members(count)),profiles(username)&clubs.registration_enabled=is.false&clubs.club_members.status=eq.active&order=created_at.asc" "${AUTH[@]}"
```

`requested_by` is NULL when the requester deleted their account (FK
`ON DELETE SET NULL`); show "(konto usunięte)".

## 2. Registration status (read-only)

The current agreement version is the string in
`supabase/functions/_shared/organizer.js` (`ORGANIZER_AGREEMENT_VERSION`) on
`origin/main`. Read it from there each time; do not remember it:

```bash
git -C /Users/derberg/Documents/GitHub/BeepBeep show origin/main:supabase/functions/_shared/organizer.js | grep ORGANIZER_AGREEMENT_VERSION
```

Enabled clubs with their owner, latest accepted version and whether payout
details exist. The IBAN is masked **in the query**, so the full value never
reaches the terminal:

```sql
SELECT c.id, c.name, c.slug, o.username AS owner,
       a.version AS latest_agreement, a.accepted_at,
       (d.club_id IS NOT NULL) AS has_payout,
       CASE WHEN d.iban IS NULL THEN NULL ELSE
         left(regexp_replace(d.iban, '\s', '', 'g'), 4) || ' … ' ||
         right(regexp_replace(d.iban, '\s', '', 'g'), 4) END AS iban_masked,
       d.updated_at AS payout_updated_at
FROM clubs c
LEFT JOIN profiles o ON o.id = c.owner_id
LEFT JOIN LATERAL (
  SELECT version, accepted_at FROM organizer_agreements
   WHERE club_id = c.id ORDER BY accepted_at DESC LIMIT 1) a ON true
LEFT JOIN club_payout_details d ON d.club_id = c.id
WHERE c.registration_enabled = true
ORDER BY c.name;
```

Compare `latest_agreement` with the current version and report "aktualna" or
"nieaktualna (<version>)" or "brak".

With curl, PostgREST cannot mask, so the IBAN is masked by a filter before
anything is printed. Never run the payout GET without the filter:

```bash
curl -s "$SUPABASE_URL/rest/v1/clubs?select=id,name,slug,owner:profiles!clubs_owner_id_fkey(username)&registration_enabled=is.true&order=name" "${AUTH[@]}"
curl -s "$SUPABASE_URL/rest/v1/organizer_agreements?select=club_id,version,accepted_at&club_id=in.(<CLUB_IDS>)&order=accepted_at.desc" "${AUTH[@]}"
curl -s "$SUPABASE_URL/rest/v1/club_payout_details?select=club_id,iban,updated_at&club_id=in.(<CLUB_IDS>)" "${AUTH[@]}" \
  | python3 -c "import sys,json
for r in json.load(sys.stdin):
    i=''.join((r.pop('iban') or '').split()); r['iban_masked']=f'{i[:4]} … {i[-4:]}' if i else None; print(r)"
```

Recent activity, **dates and action names only, no values**:

```sql
SELECT a.created_at, a.action, p.username AS actor
FROM organizer_actions a LEFT JOIN profiles p ON p.id = a.actor_id
WHERE a.club_id = '<CLUB_ID>' ORDER BY a.created_at DESC LIMIT 20;

SELECT h.changed_at, p.username AS changed_by
FROM club_payout_history h LEFT JOIN profiles p ON p.id = h.changed_by
WHERE h.club_id = '<CLUB_ID>' ORDER BY h.changed_at DESC LIMIT 20;
```

```bash
curl -s "$SUPABASE_URL/rest/v1/organizer_actions?select=created_at,action,profiles(username)&club_id=eq.<CLUB_ID>&order=created_at.desc&limit=20" "${AUTH[@]}"
curl -s "$SUPABASE_URL/rest/v1/club_payout_history?select=changed_at,profiles(username)&club_id=eq.<CLUB_ID>&order=changed_at.desc&limit=20" "${AUTH[@]}"
```

Do not select `organizer_actions.payload`/`ip`/`user_agent` or
`club_payout_history.old`/`new`: they hold payout values and IP addresses.

## 3. Enable a club (write)

1. **Resolve** the club by slug (exact) or name (`ilike`), read-only:
   ```bash
   curl -s "$SUPABASE_URL/rest/v1/clubs?select=id,name,slug,registration_enabled,owner:profiles!clubs_owner_id_fkey(username)&slug=eq.<SLUG>" "${AUTH[@]}"
   curl -s "$SUPABASE_URL/rest/v1/clubs?select=id,name,slug,registration_enabled,owner:profiles!clubs_owner_id_fkey(username)&name=ilike.*<NAME_FRAGMENT>*" "${AUTH[@]}"
   ```
   More than one match: list them and ask which. Already enabled: say so and stop.
2. **Resolve the operator** to a profile id by asking for their username (do not
   print or store their email): `profiles?select=id,username&username=eq.<OPERATOR_USERNAME>`.
3. **Show and ask.** Name, slug, owner username, then the exact change:
   > `clubs` id `<CLUB_ID>`: `registration_enabled` false → true, plus one
   > `admin_actions` row. Effect: the owner can accept the organizer agreement
   > and enter payout details. Reversible by task 4. Napisz „tak", aby włączyć.

   Anything other than an explicit "tak"/"yes" for **this** club is a no.
4. **Write** the one row, filtered by id; the response must contain exactly one row:
   ```bash
   curl -s -X PATCH "$SUPABASE_URL/rest/v1/clubs?id=eq.<CLUB_ID>&registration_enabled=is.false" "${AUTH[@]}" \
     -H "Content-Type: application/json" -H "Prefer: return=representation" \
     -d '{"registration_enabled": true}'
   ```
   SQL equivalent: `UPDATE clubs SET registration_enabled = true WHERE id = '<CLUB_ID>' RETURNING id, slug, registration_enabled;`
5. **Audit row** in `admin_actions` (columns: `admin_user_id`, `action`,
   `target_table`, `target_id`, `payload`, `ip_inet`, `user_agent`):
   ```bash
   curl -s -X POST "$SUPABASE_URL/rest/v1/admin_actions" "${AUTH[@]}" \
     -H "Content-Type: application/json" -H "Prefer: return=representation" \
     -d '{"admin_user_id": null, "action": "registration_enabled", "target_table": "clubs",
          "target_id": "<CLUB_ID>",
          "payload": {"slug": "<SLUG>", "operator_profile_id": "<OPERATOR_PROFILE_ID>", "via": "registration-operator skill"}}'
   ```
   **`admin_user_id` stays NULL.** Its foreign key points at `auth.users(id)`
   (baseline migration), and this app creates no `auth.users` rows, so a
   profile id there fails with 23503. Every existing `admin_actions` row has
   it NULL. The operator's profile id goes in `payload`. `ip_inet` and
   `user_agent` stay NULL: a terminal has neither, and IPs are never written
   by hand.
6. **Read back** `clubs?select=id,slug,registration_enabled&id=eq.<CLUB_ID>`
   and the newest `admin_actions` row for `target_id=eq.<CLUB_ID>`, and report
   both. The `registration_waitlist` row **stays** as history; never delete it.

## 4. Disable a club (write)

Same flow as task 3 (resolve, resolve operator, show, "tak", one row, audit,
read back), with these differences:

- **Refuse first** if the club owns any `registration_settings` row not in
  `draft`. Such a club has a published or closed sign-up, with runners and
  money behind it:
  ```bash
  curl -s "$SUPABASE_URL/rest/v1/registration_settings?select=event_id,state&club_id=eq.<CLUB_ID>&state=neq.draft" "${AUTH[@]}"
  ```
  Any row returned: stop, list the event ids and states, change nothing.
- Write `{"registration_enabled": false}` with filter
  `id=eq.<CLUB_ID>&registration_enabled=is.true`.
- Audit `action` is `registration_disabled`.
- Effect to state: `accept-organizer-agreement`, `update-club-payout` and
  `get-club-payout` answer 404 for this club; its agreement rows and payout
  details stay untouched.

## 5. New organizer agreement version (a PR, not a DB write)

1. `scripts/worktree.sh new feature/organizer-agreement-<version>` and work
   only in the worktree (CLAUDE.md workflow).
2. Edit the text in `public/src/legal/organizerAgreement.js` and set its
   `version: '<NEW_VERSION>'`.
3. Set `ORGANIZER_AGREEMENT_VERSION = '<NEW_VERSION>'` in
   `supabase/functions/_shared/organizer.js`. The two strings must be
   identical; `public/tests/unit/agreementVersion.test.js` fails otherwise.
4. `npm run test:unit --workspace=public` (and `npm test --workspace=backend`
   if anything else changed), commit, push, `gh pr create`, `gh pr merge --squash`
   once checks pass. The edge function deploys from `main` via CI.
5. After the deploy every owner sees the stale-version state and re-accepts,
   which inserts a **new** `organizer_agreements` row (UNIQUE `club_id, version`).
   Task 2 shows who has not re-accepted yet.

Never UPDATE or DELETE an `organizer_agreements` row to "move" a club to the
new version.
