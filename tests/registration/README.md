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
(REG_TEST_SLOT=2 node tests/registration/helpers/dpayMock.js &)
REG_TEST_SLOT=2 node --test --test-concurrency=1 "tests/registration/**/*.test.js"
REG_TEST_SLOT=2 npx playwright test -c tests/registration/playwright.config.js
scripts/test-slot.sh 2 stop
```

Slot n is a separate Supabase project (`<project_id>-s<n>`) in `.supabase-slots/<n>/` (gitignored):
a `config.toml` regenerated from `supabase/config.toml` on every call, with every port moved up by
n x 100 (API 54321+100n, DB 54322+100n, ...), and symlinks to this worktree's migrations, functions
and seed. `REG_TEST_SLOT=n` moves the ports the tests own the same way: email capture 54399+100n, dpay mock
54398+100n (and `DPAY_IPN_URL` in the slot's `functions.env` follows the API port),
scratch Postgres 55432+100n (container `leszyrun-hostpull-scratch-s<n>`), Vite 5174+100n. No
`REG_TEST_SLOT` means slot 0, which is what CI runs. Slot numbers are per machine (Docker names), so two
worktrees must not take the same one. A slot holds about 1.3 GiB of memory and 85 MB of volumes.

**Stop only your own slot.** Never `pkill -f emailCaptureServer`, `pkill -f dpayMock` or `pkill -f vite`:
those match every slot's servers, and another agent's run dies mid-test. Stop yours by the port it
LISTENS on, e.g. for slot 2: `lsof -ti tcp:54599 -sTCP:LISTEN | xargs kill` and the same for 54598
(capture 54399+100n, dpay mock 54398+100n), then `scripts/test-slot.sh 2 stop`. Keep `-sTCP:LISTEN`:
without it `lsof` also lists every process with a connection to that port, which includes Docker
Desktop's port forwarder (the slot's functions reach the mocks through `host.docker.internal`), and
killing it stops Docker and every stack on the machine. Playwright starts and stops its own Vite.

## Stalled connections from the edge-runtime container (Docker Desktop)

A TCP connection from the `supabase_edge_runtime_*` container to a server on the host sometimes stalls
before the request is sent, then completes by itself. Measured on macOS with Docker Desktop 28.5.1,
Supabase CLI 2.101.0, on 2026-11-01:

- 10 of 3,763 e-mail fetches across 4 full runs took 3, 9, 20, 36 or 68 s, against the usual 3 ms. The
  capture server saw the connection and the request only at the end of the stall, and it answered at once.
- The same durations came back in every run, close to TCP's exponential backoff (5 s plus 3, 15, 31, 63).
- `functions serve` with the host's IP instead of `host.docker.internal` stalled just the same (4 of
  3,969), so it is not DNS. Connections are not reused (one per e-mail), so it is not keep-alive either.
- A plain bash loop inside the edge-runtime container, with no Deno involved, stalled twice for 36 s in
  4,500 exchanges during a full run. The same loop in a separate container, at the same time, never stalled.

The exact mechanism inside Docker Desktop was not established. Only the edge-runtime container shows it.

A stall on the e-mail of `dpay-ipn` holds the IPN past the mock's 10 s timeout. The mock retries, the
retry answers `already_confirmed`, and the test that counted deliveries or waited for a mail fails:
P-35, P-35b, P-31, G-29. Elsewhere it only shows up as a slow test.

`postToCapture` in `_shared/email.js` gives a request 2 s and sends it again on a new connection, 4 tries
in all. It only runs with `EMAIL_CAPTURE_URL`, and a retry cannot duplicate a mail, because a stalled
request has not reached the server. It logs `Email capture: no answer in 2000 ms`. Calls from a function
to the dpay mock use the same path and are not covered: a stall there still shows up as a slow or failed
step. The same applies to any other call from a function to the host.

Separately, a call from a function through Kong can answer 502 once, with `upstream prematurely closed
connection` in Kong's log (P-58 on 2026-11-01). That is Kong and PostgREST inside the stack; nothing here handles it.

Use `db reset` between runs when you compare them: a read without a filter stops at PostgREST's 1,000 rows, and
a stack that has been through a few runs passes that number.
