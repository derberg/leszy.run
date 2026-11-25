# Admin panel e2e tests (agentic, spike)

End-to-end tests for the admin panel (`frontend/`), written with
[e2e](https://e2e.com) (Apache-2.0). A test mixes plain locator steps with
`agent.act` goals in plain language ("mark bib 2 as not starting"), and every
outcome is checked against the backend API, not only the screen. Until this
suite, nothing clicked through the admin panel.

## Run

```bash
cd frontend
npm run e2e:stack up     # isolated stack, see below
npm run test:e2e         # all tests; add a path or path:line for one
npm run e2e:stack down
```

Agent steps run on Claude Code (Sonnet) through the Agent Client Protocol,
signed in with your own `claude` login: no API key, nothing in `.env`.
Telemetry is off (`E2E_TELEMETRY_DISABLED=1` in the script).

## The stack (`stack.sh`)

Its own ports, so it never touches the Mac's real stack:

| Service | Port | Notes |
| --- | --- | --- |
| Postgres | 55471 | Docker container `e2e-admin-pg`, no volume, gone on `down` |
| Mosquitto | 18871 | Its own broker: the backend's MQTT client id is fixed, so sharing `:1883` would disconnect the real backend |
| Backend | 3071 | Started with `env -i` and no `--env-file`: the repo-root `.env` (real DB, production Supabase) is never read, so every sync worker is off |
| Admin UI | 3072 | Vite, pointed at 3071 |

Logs: `/tmp/e2e-admin-stack/`.

## How the tests work

- Each test seeds its own event through the backend API (`lib/stack.js`),
  so tests share nothing.
- Check-ins are written straight into the scratch Postgres: the panel's
  check-in goes to Supabase first, and the stack has none.
- RFID reads are published to the stack's Mosquitto in the R700
  `tagInventory` format (`publishReads`, `pass`), so the real crossing
  detector times the race. `min_finish_seconds` is 5 s to keep a race short.

## Cost and the replay cache

A passing `agent.act` is cached in `.e2e/cache/` once a later screen check
confirms it, and replays with no model call until the UI changes. With a warm
cache the suite makes one model call (the `agent.assert`, never cached) and
takes about 30 s; a cold run is about 70 s and 5 calls. The cost e2e prints
is nominal: Claude Code bills your subscription.

What breaks the cache, learned writing these tests:

- **Random or time-dependent labels.** The table names rows by each runner's
  random emoji, and the chip-tie cell by its finish time. A recorded tap on
  either never replays. Seeds pin the emojis (`pinEmojis`), and the tie
  popover is opened with a fixed locator (`⇅`).
- **An act with no screen check after it** is never saved. Put an
  `expect(screen…)` or `agent.assert` after every `agent.act`; an API poll
  does not count.
- Use a locator, not an agent step, for anything one click does (a tab).

## Where agentic steps fit, and where they don't

Good: walking UI flows whose markup changes (inline-edit tables, dialogs,
popovers) and phrasing a step the way an operator would. Not for timing
correctness, money or sync: those keep their exact node tests, and every
test here checks its outcome through the API with exact values.

The `claudeCode` executor once ran a tool of its own on a cache miss, which
e2e stopped (`POLICY_DENIED`). Watch for it before relying on a run in CI.
