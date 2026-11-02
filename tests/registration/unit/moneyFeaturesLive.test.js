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

// [supabaseUrl, testSwitch, offHeader]: every address, test switch and header a request can carry.
// With PAID_REGISTRATION_ENABLED true the features are live for all of them: the local test switch
// and the x-registration-money header are only consulted while the flag is false.
const CASES = [
  // Production: the deployed project is https and has no test switch.
  ['https://abcdefghijklmnop.supabase.co', undefined, null],
  ['https://abcdefghijklmnop.supabase.co', 'on', null],
  ['https://abcdefghijklmnop.supabase.co', undefined, 'off'],
  ['https://127.0.0.1:54321', 'on', null],
  // The local test stack, with and without its switch.
  ['http://127.0.0.1:54321', undefined, null],
  ['http://127.0.0.1:54321', 'off', null],
  ['http://127.0.0.1:54321', 'on', null],
  ['http://localhost:54421', 'on', null],
  ['  http://127.0.0.1:54321/  ', 'on', null],
  ['http://127.0.0.1.evil.example:54321', 'on', null],
  [undefined, 'on', null],
  ['', undefined, null],
  // The off header is ignored by design once the flag is on.
  ['http://127.0.0.1:54321', 'on', 'off'],
  ['http://127.0.0.1:54321', 'on', 'on'],
]

describe('moneyFeaturesLive (edge, V-98)', () => {
  it('production: the flag is on', () => {
    assert.equal(PAID_REGISTRATION_ENABLED, true)
  })

  for (const [supabaseUrl, testSwitch, offHeader] of CASES) {
    it(`${JSON.stringify(supabaseUrl)} switch=${testSwitch} header=${offHeader} → live`, () => {
      assert.equal(moneyFeaturesLive({ supabaseUrl, testSwitch, offHeader }), true)
    })
  }

  it('no arguments at all → live', () => {
    assert.equal(moneyFeaturesLive(), true)
    assert.equal(moneyFeaturesLive({}), true)
  })

  it('the public copy answers the same for every case', () => {
    for (const [supabaseUrl, testSwitch, offHeader] of CASES) {
      const env = { VITE_SUPABASE_URL: supabaseUrl, ...(testSwitch === undefined ? {} : { REGISTRATION_MONEY_TEST: testSwitch }) }
      assert.equal(moneyLiveForApi(env, offHeader), true, JSON.stringify([supabaseUrl, testSwitch, offHeader]))
    }
    assert.equal(moneyLiveForApi(undefined, null), true)
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

  it('production: an https SUPABASE_URL and no switch → live', () => {
    withEnv({ SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' })
    assert.equal(moneyLiveFor(req()), true)
  })

  it('production: `x-registration-money: off` is ignored → still live', () => {
    withEnv({ SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' })
    assert.equal(moneyLiveFor(req({ [MONEY_OFF_HEADER]: 'off' })), true)
  })

  it('the local test stack, with or without the switch and the off header → live', () => {
    withEnv({ SUPABASE_URL: 'http://127.0.0.1:54321', [MONEY_TEST_ENV]: 'on' })
    assert.equal(moneyLiveFor(req()), true)
    assert.equal(moneyLiveFor(req({ [MONEY_OFF_HEADER]: 'off' })), true)
    withEnv({ SUPABASE_URL: 'http://127.0.0.1:54321' })
    assert.equal(moneyLiveFor(req()), true)
  })

  it('outside Deno, or with no request → live', () => {
    delete globalThis.Deno
    assert.equal(moneyLiveFor(req()), true)
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
