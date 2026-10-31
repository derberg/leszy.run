# dpay sandbox acceptance suite

Real dpay sandbox, the LOCAL Supabase stack, the real edge functions. It proves what the mocked dpay
(`../helpers/dpayMock.js`) can only assume: the real IPN reaches us, `parseDpayAmount` accepts the real
`amount`, refunds and `details` answer the way `_shared/dpay.js` reads them. **Never in PR CI.** It runs by
hand or nightly (`.github/workflows/registration-sandbox.yml`, GitHub environment `dpay-sandbox`).

Without `DPAY_ENV=sandbox` every test is skipped ("DPAY_ENV is not sandbox").

| Test | What it proves |
|---|---|
| S-01 | BLIK on the real gateway, the real IPN reaches the tunnel: order `paid`, a participant exists, `parseDpayAmount` accepts the raw `amount` (logged) |
| S-02 | the same with a card |
| S-03 | a declined card leaves the order pending; `pay-order` then pays it (skipped without `DPAY_SANDBOX_DECLINE_CARD_NUMBER`) |
| S-04 | refunds of 10,00 zł then 5,00 zł accepted, one over the rest is 400; `details` reports the refunded sum (soft assertion) |
| S-05 | the transaction is registered with an unreachable IPN URL: `order-status` confirms through `details` (no `ipn` event, a `status_check` event) |
| S-06 | records the real `details` shape before and after a partial refund, the refund response, and whether a repeated `DigitalPayments-PSP-Message-ID` refunds twice |

Until S-05 and S-06 pass against the sandbox, the poll path is unproven against dpay.

**Before `PAID_REGISTRATION_ENABLED` flips:** confirm dpay's minimum transaction amount here. The total is
now the entry prices alone, so an organizer's 0,01 zł price (`sections.js` accepts it) reaches dpay as 0,01 zł,
where it used to be at least 0,21 zł. No document in this repo states dpay's minimum, and no test covers it yet.
The run log is `tests/registration/test-results/sandbox-run-log.json` (field names, types and lengths only).

## Production hosts (the suite refuses these)

`DPAY_SANDBOX_API_BASE` and `DPAY_SANDBOX_PANEL_BASE` must not have one of these hostnames (`guard.js`,
`PRODUCTION_DPAY_HOSTS`, unit-tested in `guard.test.js`); an unparsable URL is refused too:

`dpay.pl`, `www.dpay.pl`, `secure.dpay.pl`, `panel.dpay.pl`, `api.dpay.pl`

Check the list against dpay's docs when you get the sandbox credentials, and add any live host that is missing.

## Environment

| Variable | Meaning |
|---|---|
| `DPAY_ENV` | `sandbox` switches the suite on |
| `DPAY_SANDBOX_SERVICE`, `DPAY_SANDBOX_SECRET` | the sandbox service and its secret |
| `DPAY_SANDBOX_API_BASE`, `DPAY_SANDBOX_PANEL_BASE` | sandbox hosts (registration / panel API) |
| `DPAY_SANDBOX_BLIK_CODE` | a BLIK code the sandbox accepts |
| `DPAY_SANDBOX_CARD_NUMBER`, `DPAY_SANDBOX_CARD_EXPIRY`, `DPAY_SANDBOX_CARD_CVC` | the sandbox test card |
| `DPAY_SANDBOX_DECLINE_CARD_NUMBER` | optional: a card the sandbox declines (S-03) |
| `SANDBOX_PUBLIC_IPN_URL` | public URL of the local `dpay-ipn`, e.g. `https://<id>.trycloudflare.com/functions/v1/dpay-ipn` |

## Running locally

Needs Docker, the Supabase CLI, `cloudflared` and Playwright's Chromium.

```bash
# 1. stack + email capture (the stack serves the functions on :54321)
node tests/registration/helpers/emailCaptureServer.js &
tests/registration/start-stack.sh && supabase db reset

# 2. a public tunnel to the local functions gateway; copy the https URL it prints
cloudflared tunnel --url http://127.0.0.1:54321 &

# 3. the settings (export the DPAY_SANDBOX_* values first)
export DPAY_ENV=sandbox
export SANDBOX_PUBLIC_IPN_URL=https://<id>.trycloudflare.com/functions/v1/dpay-ipn

# 4. functions with the sandbox settings; the file is written OUTSIDE the repo (it holds the secret)
node tests/registration/sandbox/write-functions-env.js "$TMPDIR/functions.sandbox.env"
supabase functions serve --env-file "$TMPDIR/functions.sandbox.env" &

# 5. the suite
npx playwright test -c tests/registration/sandbox/playwright.sandbox.config.js
rm "$TMPDIR/functions.sandbox.env"
```

In test slot n (`scripts/test-slot.sh`, see `../README.md`) the gateway is on 54321 + n x 100: tunnel that
port, export `REG_TEST_SLOT=n` before step 4 (the env file then points at the slot's e-mail capture), and
use `scripts/test-slot.sh n functions serve --env-file …`.

The unit part needs no sandbox: `node --test tests/registration/sandbox/guard.test.js`.

## Known unknowns

- dpay's payment page markup is undocumented. The locators in `payBlik` / `payCard` (`acceptance.spec.js`)
  are a first guess and will likely need adjusting on the first run; a trace and screenshot are kept on failure.
- The sandbox may not honour a `localhost` return URL; the suite does not follow the payer's redirect.
- Playwright cannot import `supabase/functions/_shared/*.js` (read as CommonJS), so `bridge.mjs` runs the real
  `dpay.js` / `money.js` / order helpers in a child Node process.
