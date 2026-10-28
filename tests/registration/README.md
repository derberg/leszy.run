# Registration tests (local Supabase stack)

Everything here runs against a local Supabase stack, never production.
`localEnv()` refuses any URL that is not `http://127.0.0.1`.

```bash
# from the repo root; needs Docker and the Supabase CLI
node tests/registration/helpers/emailCaptureServer.js &      # email capture on :54399
node tests/registration/helpers/dpayMock.js &               # mocked dpay on :54398
tests/registration/start-stack.sh && supabase db reset                          # applies migrations + supabase/seed.sql
supabase functions serve --env-file tests/registration/functions.env &
node --test --test-concurrency=1 "tests/registration/**/*.test.js"
npx playwright test -c tests/registration/playwright.config.js
```

`start-stack.sh` holds the list of Supabase services the tests do not need (the one copy).

Emails the functions send land in the capture server (`messagesTo`, `lastCodeFor`).
dpay is never called: `functions.env` points the functions at the mock (`helpers/dpayMock.js`), which checks
every checksum, serves a pay page („Zapłać (mock)” / „Odrzuć (mock)”), posts signed IPNs and refunds without
deduplicating. Tests drive it through `helpers/dpayControl.js` (`dpayReset`, `dpayMode`, `payMock`, `replayIpn`, …).
`sessionFor(email)` logs a test user in without email; `loginViaEmail` does the real flow.
`helpers/hostPull.js` is a scratch timing host: a `postgres:16` on `127.0.0.1:55432`, migrated with the
backend's Drizzle migrations, pulled into by the backend's `pullConfig()`. CI runs it as a service; locally
the helper starts a throwaway container when nothing answers on 55432 and removes it afterwards.
The scenario list is `docs/registration/scenario-matrix.md`.

## Parallel stacks (test slots)

The commands above use slot 0, the one stack every worktree shares. To test while another
worktree or agent is using it, take your own slot n (1..9) and run everything through it:

```bash
scripts/test-slot.sh 2 start && scripts/test-slot.sh 2 db reset
(scripts/test-slot.sh 2 functions serve &)                      # this worktree's functions, slot 2's functions.env
(REG_TEST_SLOT=2 node tests/registration/helpers/emailCaptureServer.js &)
REG_TEST_SLOT=2 node --test --test-concurrency=1 "tests/registration/**/*.test.js"
REG_TEST_SLOT=2 npx playwright test -c tests/registration/playwright.config.js
scripts/test-slot.sh 2 stop
```

Slot n is a separate Supabase project (`<project_id>-s<n>`) in `.supabase-slots/<n>/` (gitignored):
a `config.toml` regenerated from `supabase/config.toml` on every call, with every port moved up by
n x 100 (API 54321+100n, DB 54322+100n, ...), and symlinks to this worktree's migrations, functions
and seed. `REG_TEST_SLOT=n` moves the ports the tests own the same way: email capture 54399+100n,
scratch Postgres 55432+100n (container `leszyrun-hostpull-scratch-s<n>`), Vite 5174+100n. No
`REG_TEST_SLOT` means slot 0, which is what CI runs. Slot numbers are per machine (Docker names), so two
worktrees must not take the same one. A slot holds about 1.3 GiB of memory and 85 MB of volumes.
