// Plan 7 follow-up NB-4 (V-98): the edge side of the money switch, tested directly. flags.js
// `moneyFeaturesLive` decides for every money path of the edge functions, and `moneyLiveFor(req)`
// feeds it the function's own SUPABASE_URL, REGISTRATION_MONEY_TEST and the request's
// x-registration-money header. The public copy (public/src/lib/moneyFeatures.js) must answer the
// same for every address both of them know.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MONEY_OFF_HEADER, MONEY_TEST_ENV, PAID_REGISTRATION_ENABLED, moneyFeaturesLive,
} from '../../../supabase/functions/_shared/registration/flags.js'
import {
  moneyLiveFor, payloadWithoutMoneyFeatures, rawWithoutMoneyFeatures,
} from '../../../supabase/functions/_shared/registration/moneyLive.js'
import { moneyLiveForApi, withoutMoneyFeatures } from '../../../public/src/lib/moneyFeatures.js'

// [supabaseUrl, testSwitch, offHeader, live]
const CASES = [
  // Production: the deployed project is https and has no test switch.
  ['https://abcdefghijklmnop.supabase.co', undefined, null, false],
  ['https://abcdefghijklmnop.supabase.co', 'on', null, false],
  ['https://abcdefghijklmnop.supabase.co', 'on', 'on', false],
  ['https://127.0.0.1:54321', 'on', null, false],
  // The switch alone, or a local address alone, is not enough.
  ['http://127.0.0.1:54321', undefined, null, false],
  ['http://127.0.0.1:54321', 'off', null, false],
  ['http://127.0.0.1:54321', 'ON', null, false],
  ['http://127.0.0.1:54321', 'on', null, true],
  ['http://localhost:54421', 'on', null, true],
  ['http://localhost', 'on', null, true],
  ['  http://127.0.0.1:54321/  ', 'on', null, true],
  // A look-alike host is not local.
  ['http://127.0.0.1.evil.example:54321', 'on', null, false],
  ['http://localhost.example.com', 'on', null, false],
  ['http://example.com/http://127.0.0.1', 'on', null, false],
  [undefined, 'on', null, false],
  ['', 'on', null, false],
  // The header can only turn the features off.
  ['http://127.0.0.1:54321', 'on', 'off', false],
  ['http://127.0.0.1:54321', 'on', 'on', true],
  ['http://127.0.0.1:54321', undefined, 'on', false],
]

describe('moneyFeaturesLive (edge, V-98)', () => {
  it('the production default: the flag is off', () => {
    assert.equal(PAID_REGISTRATION_ENABLED, false)
  })

  for (const [supabaseUrl, testSwitch, offHeader, live] of CASES) {
    it(`${JSON.stringify(supabaseUrl)} switch=${testSwitch} header=${offHeader} → ${live ? 'live' : 'off'}`, () => {
      assert.equal(moneyFeaturesLive({ supabaseUrl, testSwitch, offHeader }), live)
    })
  }

  it('no arguments at all → off', () => {
    assert.equal(moneyFeaturesLive(), false)
    assert.equal(moneyFeaturesLive({}), false)
  })

  it('the public copy answers the same for every address it knows (127.0.0.1 and localhost)', () => {
    for (const [supabaseUrl, testSwitch, offHeader, live] of CASES) {
      const env = { VITE_SUPABASE_URL: supabaseUrl, ...(testSwitch === undefined ? {} : { REGISTRATION_MONEY_TEST: testSwitch }) }
      assert.equal(moneyLiveForApi(env, offHeader), live, JSON.stringify([supabaseUrl, testSwitch, offHeader]))
    }
  })

  it('the Docker-side local names (kong, host.docker.internal) are local only on the edge side', () => {
    assert.equal(moneyFeaturesLive({ supabaseUrl: 'http://kong:8000', testSwitch: 'on', offHeader: null }), true)
    assert.equal(moneyFeaturesLive({ supabaseUrl: 'http://host.docker.internal:54321', testSwitch: 'on', offHeader: null }), true)
    assert.equal(moneyFeaturesLive({ supabaseUrl: 'https://kong:8000', testSwitch: 'on', offHeader: null }), false)
  })
})

describe('moneyLiveFor(req) (edge, V-98)', () => {
  const saved = globalThis.Deno
  afterEach(() => {
    if (saved === undefined) delete globalThis.Deno
    else globalThis.Deno = saved
  })
  const withEnv = (vars) => {
    globalThis.Deno = { env: { get: (k) => vars[k] } }
  }
  const req = (headers = {}) => new Request('http://localhost/x', { method: 'POST', headers })

  it('production: an https SUPABASE_URL and no switch → off', () => {
    withEnv({ SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' })
    assert.equal(moneyLiveFor(req()), false)
  })

  it('production: the switch set by mistake on an https project → still off', () => {
    withEnv({ SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', [MONEY_TEST_ENV]: 'on' })
    assert.equal(moneyLiveFor(req()), false)
  })

  it('the local test stack (REGISTRATION_MONEY_TEST=on, http://127.0.0.1) → live', () => {
    withEnv({ SUPABASE_URL: 'http://127.0.0.1:54321', [MONEY_TEST_ENV]: 'on' })
    assert.equal(moneyLiveFor(req()), true)
  })

  it('the local test stack with `x-registration-money: off` on the request → off', () => {
    withEnv({ SUPABASE_URL: 'http://127.0.0.1:54321', [MONEY_TEST_ENV]: 'on' })
    assert.equal(moneyLiveFor(req({ [MONEY_OFF_HEADER]: 'off' })), false)
    assert.equal(moneyLiveFor(req({ [MONEY_OFF_HEADER]: 'on' })), true)
  })

  it('the header cannot turn the features on in production', () => {
    withEnv({ SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' })
    assert.equal(moneyLiveFor(req({ [MONEY_OFF_HEADER]: 'on' })), false)
  })

  it('outside Deno, or with no request → off', () => {
    delete globalThis.Deno
    assert.equal(moneyLiveFor(req()), false)
    withEnv({ SUPABASE_URL: 'http://127.0.0.1:54321', [MONEY_TEST_ENV]: 'on' })
    assert.equal(moneyLiveFor(undefined), true)
  })
})

describe('the preview\'s strip (NB-3, V-97)', () => {
  it('rawWithoutMoneyFeatures is the public page\'s withoutMoneyFeatures', () => {
    const raw = { isCharity: true, donationsEnabled: true, extras: [{ id: 'x', name: 'Koszulka' }], name: 'Bieg' }
    assert.deepEqual(rawWithoutMoneyFeatures(raw), withoutMoneyFeatures(raw))
    assert.equal(raw.extras.length, 1, 'the input is not changed')
    assert.equal(rawWithoutMoneyFeatures(null), null)
  })

  it('payloadWithoutMoneyFeatures drops staged extras and the staged donations switch, nothing else', () => {
    const payload = {
      basics: { donations_enabled: true, first_start_time: '10:15', is_charity: true },
      extras: { items: [{ name: 'Czapka' }] },
      competitions: { pricing_mode: 'free', items: [] },
    }
    assert.deepEqual(payloadWithoutMoneyFeatures(payload), {
      basics: { first_start_time: '10:15', is_charity: true },
      competitions: { pricing_mode: 'free', items: [] },
    })
    assert.equal(payload.basics.donations_enabled, true, 'the input is not changed')
    assert.ok(payload.extras)
    assert.deepEqual(payloadWithoutMoneyFeatures({ office: { hours: [] } }), { office: { hours: [] } })
    assert.equal(payloadWithoutMoneyFeatures(null), null)
  })
})
