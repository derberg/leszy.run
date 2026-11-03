// A team member's own details: the captain gives the name, birth date, gender and e-mail of an
// adult member, and the member fills everything else the event asks for on /zgoda.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryOwedDetails, missingDetails, missingDetailsText, owedDetails, ownsDetails, stillMissing,
} from '../../../supabase/functions/_shared/registration/memberDetails.js'

const EMPTY = { phone: null, city: null, club: null, iceName: null, icePhone: null, nationality: null }
const FULL = { phone: '600100200', city: 'Gliwice', club: 'ZATYRANI', iceName: 'Jan', icePhone: '600100201', nationality: 'PL' }

test('MD-01 the phone is always owed; city, club and ICE only when required; nationality off by default', () => {
  assert.deepEqual(Object.keys(missingDetails(EMPTY, {})), ['phone'])
  assert.deepEqual(Object.keys(missingDetails(EMPTY, { city: 'required', club: 'optional', ice: 'off' })), ['phone', 'city'])
  assert.deepEqual(Object.keys(missingDetails(EMPTY, { ice: 'required', nationality: 'required' })),
    ['phone', 'iceName', 'icePhone', 'nationality'])
  assert.equal(missingDetails(EMPTY, {}).phone, 'Podaj numer telefonu.')
})

test('MD-02 a filled field is not owed; whitespace is not a value', () => {
  const all = { city: 'required', club: 'required', ice: 'required', nationality: 'required' }
  assert.deepEqual(missingDetails(FULL, all), {})
  assert.deepEqual(Object.keys(missingDetails({ ...FULL, club: '  ' }, all)), ['club'])
  // A stored phone mode is ignored, as validatePerson ignores it.
  assert.deepEqual(Object.keys(missingDetails({ ...FULL, phone: '' }, { phone: 'off' })), ['phone'])
})

test('MD-03 only a team member who is not a child owns their details', () => {
  const member = { team_id: 't1', registered_by_profile_id: 'cap', profile_id: null, consent_state: 'awaiting' }
  assert.equal(ownsDetails(member), true)
  assert.equal(ownsDetails({ ...member, consent_state: 'accepted', profile_id: 'm1' }), true)
  assert.equal(ownsDetails({ ...member, guardian_name: 'Kasia' }), false, 'a child: the captain gives everything')
  assert.equal(ownsDetails({ ...member, team_id: null }), false, 'a group member: the payer gave everything')
  assert.equal(ownsDetails({ team_id: 't1', registered_by_profile_id: 'cap', profile_id: 'cap', consent_state: 'accepted' }), false,
    'the captain filled their own form')
})

test('MD-04 owedDetails: the owner\'s missing fields from a stored row, nobody else\'s', () => {
  const row = { team_id: 't1', registered_by_profile_id: 'cap', profile_id: null, consent_state: 'awaiting',
    phone: null, city: 'Gliwice', club: null, ice_name: null, ice_phone: null, nationality: null }
  assert.deepEqual(owedDetails(row, { city: 'required', club: 'required' }), ['phone', 'club'])
  assert.deepEqual(owedDetails({ ...row, team_id: null }, { club: 'required' }), [])
  assert.deepEqual(owedDetails({ ...row, phone: '600100200', club: 'X' }, { club: 'required' }), [])
})

test('MD-05 stillMissing: of the fields the page was told are owed, the ones the person left empty', () => {
  assert.deepEqual(stillMissing(['phone', 'club'], { ...EMPTY, phone: '600' }, { club: 'required' }),
    { club: 'Podaj klub.' })
  assert.deepEqual(stillMissing([], EMPTY, { club: 'required' }), {}, 'nothing owed: nothing is asked')
  assert.deepEqual(stillMissing(['phone'], FULL, {}), {})
})

test('MD-06 missingDetailsText: the organizer\'s words, the ICE pair once', () => {
  assert.equal(missingDetailsText(['phone', 'iceName', 'icePhone', 'nationality']), 'telefon, kontakt ICE, narodowość')
  assert.equal(missingDetailsText([]), '')
  assert.equal(missingDetailsText(null), '')
})

test('MD-07 entryOwedDetails: the organizer\'s flag, for a live entry until race day only', () => {
  const row = { team_id: 't1', registered_by_profile_id: 'cap', profile_id: null, consent_state: 'awaiting', status: 'confirmed',
    phone: null, city: null, club: null, ice_name: null, ice_phone: null, nationality: null }
  const settings = { event_date: '2026-12-06', form_fields: { city: 'required' } }
  const now = new Date('2026-11-06T10:00:00Z')
  assert.deepEqual(entryOwedDetails(row, settings, now), ['phone', 'city'])
  assert.deepEqual(entryOwedDetails(row, settings, new Date('2026-12-06T10:00:00Z')), ['phone', 'city'], 'race day itself: still owed')
  // The 30-day contact purge nulls every phone of a past event: that is not a missing detail.
  assert.deepEqual(entryOwedDetails(row, settings, new Date('2026-12-07T10:00:00Z')), [])
  assert.deepEqual(entryOwedDetails({ ...row, status: 'cancelled' }, settings, now), [])
  assert.deepEqual(entryOwedDetails({ ...row, status: 'pending_payment' }, settings, now), ['phone', 'city'])
})
