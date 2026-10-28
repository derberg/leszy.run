# Registration tests (local Supabase stack)

Everything here runs against a local Supabase stack, never production.
`localEnv()` refuses any URL that is not `http://127.0.0.1`.

```bash
# from the repo root; needs Docker and the Supabase CLI
node tests/registration/helpers/emailCaptureServer.js &      # email capture on :54399
supabase start -x studio,imgproxy,postgres-meta,logflare,vector,mailpit,storage-api,realtime && supabase db reset                          # applies migrations + supabase/seed.sql
supabase functions serve --env-file tests/registration/functions.env &
node --test --test-concurrency=1 "tests/registration/**/*.test.js"
npx playwright test -c tests/registration/playwright.config.js
```

Emails the functions send land in the capture server (`messagesTo`, `lastCodeFor`).
`sessionFor(email)` logs a test user in without email; `loginViaEmail` does the real flow.
The scenario list is `docs/registration/scenario-matrix.md`.
