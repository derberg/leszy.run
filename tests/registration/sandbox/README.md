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
| S-07 | the organizer's refunds through `organizer-refund` (Plan 6): 10,00 zł accepted, the rest accepted and the entry cancelled, a third request 409 `exceeds` with no dpay call; `details` shows the refunded sum |
| S-08 | a cart (Plan 7): a 15 % code, a shirt and a donation; the real IPN `amount` equals `orders.total`; an organizer refund of the extra line alone is `accepted` |

Until S-05 and S-06 pass against the sandbox, the poll path is unproven against dpay.

**Before `PAID_REGISTRATION_ENABLED` flips:** confirm dpay's minimum transaction amount here. The total is
now the entry prices alone, so an organizer's 0,01 zł price (`sections.js` accepts it) reaches dpay as 0,01 zł,
where it used to be at least 0,21 zł. No document in this repo states dpay's minimum, and no test covers it yet.
The run log is `tests/registration/test-results/sandbox-run-log.json` (field names, types and lengths only).

## Test mode

dpay has no separate sandbox host. Test mode is a switch on a payment service, on the same hosts as
production ([docs.dpay.pl: Środowisko testowe](https://docs.dpay.pl/docs/pierwsze-kroki/srodowisko-testowe/)):

- `DPAY_SANDBOX_API_BASE=https://api-payments.dpay.pl` (`/api/v1_0/payments/register`)
- `DPAY_SANDBOX_PANEL_BASE=https://panel.dpay.pl` (`/api/v1/pbl/details`, `/api/v1/pbl/refund`)

So the suite needs its own service with test mode on. The dpay panel does not offer test mode on an active
production service, so this must be a separate, unverified service (ours is `leszyrun-sandbox`). Never point
the suite at the production service (`LESZY.RUN`): on it the test numbers below are ordinary payment data.

`guard.js` refuses to run unless `DPAY_SANDBOX_SERVICE` contains `sandbox` or `test` (case-insensitive), and
unless both bases are https URLs on a `dpay.pl` host (unit-tested in `guard.test.js`). The name rule is only
the machine-checkable part; the real protection is that only the test-mode service is ever configured here.

Test values from the docs page above: BLIK `777200` (success), card `4111111111111111` (success),
`4000000000000002` (declined, for `DPAY_SANDBOX_DECLINE_CARD_NUMBER`). On a new service dpay may still have
cards pending its approval, so S-02 and S-03 can fail until it approves them.

## Environment

| Variable | Meaning |
|---|---|
| `DPAY_ENV` | `sandbox` switches the suite on |
| `DPAY_SANDBOX_SERVICE`, `DPAY_SANDBOX_SECRET` | the test-mode service (its identifier must contain `sandbox` or `test`) and its secret |
| `DPAY_SANDBOX_API_BASE`, `DPAY_SANDBOX_PANEL_BASE` | `https://api-payments.dpay.pl` / `https://panel.dpay.pl` (see Test mode) |
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

## Findings from the first green run (2026-11-01, run 41349324225, service `leszyrun-sandbox` in test mode)

- A service in test mode shows dpay's simulator page („Symuluj sukces” / „Symuluj niepowodzenie”), not a BLIK or card form. The pay helpers click it; the BLIK code and card numbers are unused in test mode.
- The IPN `amount` is a string with a dot and two decimals (`"60.00"`). Its keys are `amount`, `attempt`, `custom`, `id`, `signature`, `type`, `version`.
- `/pbl/details` reports refunds in `refunded_amount` and `available_refund_amount`.
- **A refund repeated with the same `DigitalPayments-PSP-Message-ID` is accepted twice** (S-06). dpay does not deduplicate, so our one-claim-per-refund rule (`refunds.requested_at`) is the only guard against a double refund.
- dpay rate-limits its payment page per client and answers „Błąd 429 Za dużo zapytań”; `openGateway` waits a minute and retries.
