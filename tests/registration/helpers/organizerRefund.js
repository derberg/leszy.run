// The organizer refund's copy and the mocked dpay as the tests reach it from the host. Task 3 ran
// the D6-18 pipeline here in-process until Plan 6 Task 4's `organizer-refund` function existed; the
// race tests now call that function (callFn('organizer-refund', …)), so this file keeps only what
// they compare its answers with.
import { localEnv } from './stack.js'
import { DPAY_MOCK_PORT } from './dpayMock.js'
import { dpayConfig } from '../../../supabase/functions/_shared/dpay.js'
import { formatPln } from '../../../supabase/functions/_shared/registration/money.js'

export const UNCONFIRMED = 'Zwrot niepotwierdzony.'
export const INSUFFICIENT = 'Operator płatności odrzucił zwrot: brak środków.'
export const REJECTED = 'Operator płatności odrzucił zwrot.'
export const RACE_DAY = 'Zwroty są zamknięte od dnia zawodów.'
export const exceedsCopy = (grosze) => `Kwota przekracza możliwą do zwrotu: ${formatPln(grosze)}.`

/** The mocked dpay as the functions reach it, from the host. `timeoutMs` shortens the refund wait. */
export const nodeDpay = ({ timeoutMs } = {}) => {
  const cfg = dpayConfig({
    DPAY_SERVICE: 'mock-service', DPAY_SECRET: 'mock-secret',
    DPAY_API_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`, DPAY_PANEL_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`,
    DPAY_IPN_URL: `${localEnv().url}/functions/v1/dpay-ipn`, PUBLIC_SITE_URL: 'http://localhost:5173',
  })
  return timeoutMs ? { ...cfg, timeoutMs } : cfg
}
