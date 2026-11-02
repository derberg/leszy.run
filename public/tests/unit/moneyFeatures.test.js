// Plan 7 final review I-1 + I-4: the public read model. PAID_REGISTRATION_ENABLED is true, so /api/event
// serves donations and extras; withoutMoneyFeatures is the strip it would apply with the flag off.
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
  it('the flag is on: live everywhere, on https and locally, and the off header is ignored', () => {
    assert.equal(MONEY_FEATURES_FLAG, true)
    const local = 'http://127.0.0.1:54421'
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: local, REGISTRATION_MONEY_TEST: 'on' }, null), true)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: local, REGISTRATION_MONEY_TEST: 'on' }, 'off'), true)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: local }, null), true)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: 'https://abc.supabase.co' }, null), true)
    assert.equal(moneyLiveForApi({ VITE_SUPABASE_URL: 'https://abc.supabase.co' }, 'off'), true)
    assert.equal(moneyLiveForApi({}, null), true)
  })
})
