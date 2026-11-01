// Plan 7 final review I-1 + I-4: the public read model while PAID_REGISTRATION_ENABLED is false.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MONEY_FEATURES_FLAG, moneyLiveForApi, withoutMoneyFeatures } from '../../src/lib/moneyFeatures.js'
import { PAID_REGISTRATION_ENABLED } from '../../../supabase/functions/_shared/registration/flags.js'

const RAW = {
  isCharity: true, charityGoal: 'Rehabilitacja Zosi', donationsEnabled: true,
  extras: [{ id: 'x', name: 'Koszulka', price: 4500, variants: [] }, { id: 'y', name: 'Rozmiar', price: 0, variants: [] }],
  competitions: [{ categoryId: 'c', name: 'Bieg 9 km' }],
}

describe('moneyFeatures (V-90)', () => {
  it('the public app\'s copy of the flag is the edge functions\' PAID_REGISTRATION_ENABLED', () => {
    assert.equal(MONEY_FEATURES_FLAG, PAID_REGISTRATION_ENABLED)
  })
  it('off: no donations and no extras (priced or 0 zł); the rest of the event is untouched', () => {
    const out = withoutMoneyFeatures(RAW)
    assert.equal(out.donationsEnabled, false)
    assert.deepEqual(out.extras, [])
    assert.equal(out.isCharity, true)
    assert.equal(out.charityGoal, 'Rehabilitacja Zosi')
    assert.deepEqual(out.competitions, RAW.competitions)
    assert.equal(RAW.extras.length, 2, 'the input is not changed')
  })
  it('live only on a local http Supabase with the test switch on, never on https, and off by the header', () => {
    const local = 'http://127.0.0.1:54421'
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: local, REGISTRATION_MONEY_TEST: 'on' }, null), true)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: local, REGISTRATION_MONEY_TEST: 'on' }, 'off'), false)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: local }, null), false)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: 'https://abc.supabase.co', REGISTRATION_MONEY_TEST: 'on' }, null), false)
    assert.equal(moneyLiveForApi({}, null), false)
  })
})
