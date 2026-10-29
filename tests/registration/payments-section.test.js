// Plan 3, task 8: the Płatności step (P-40…P-42 in
// docs/registration/scenario-matrix.md). The payment window is a wizard
// section (D3-4): saved straight into a draft, staged on a published event and
// applied by „Opublikuj zmiany”. The payout account of one event lives in
// event_payout_details, written only by update-event-payout (club owner) and
// read only by get-event-payout (owner: every field, admin: masked, member:
// 403), never through get-registration-event or the public read model
// (ruling P3-R1). LOCAL stack only; every club and event is random, so reruns pass.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { admin, authenticatedClient, localEnv, sessionFor } from './helpers/stack.js'
import { clearMessages, messagesTo, startCapture } from './helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent, makeClub } from './helpers/registrationFixtures.js'

const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()

const IBAN = 'PL61109010140000071219812874'
const IBAN_DIGITS = '109010140000071219812874'
const NIP = '5260250274'
const CUSTOM = {
  mode: 'custom', recipient: 'Fundacja Leśna Pomoc', taxId: '526-025-02-74',
  iban: 'pl61 1090 1014 0000 0712 1981 2874', title: 'Bieg Leszego — wpisowe',
}

let club, slug, owner, clubAdmin, member, outsider, stopCapture
before(async () => {
  stopCapture = await startCapture()
  slug = `p3-pay-${rand()}`
  club = await makeClub({ slug })
  ;[owner, clubAdmin, member, outsider] = await Promise.all(
    [club.ownerEmail, club.adminEmail, club.memberEmail, 'owner@inny-klub.local'].map(sessionFor))
})
after(async () => { if (stopCapture) await stopCapture() })

const save = (eventId, value, session = owner, section = 'payments') =>
  callFn('save-registration-section', session, { eventId, section, value })
const setPayout = (eventId, body, session = owner) => callFn('update-event-payout', session, { eventId, ...body })
const readPayout = (eventId, session) => callFn('get-event-payout', session, { eventId })

async function draft() {
  const r = await callFn('create-registration-event', owner, { clubId: club.clubId, name: `Bieg Leszego ${rand()}` })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.data.eventId
}

async function settingsOf(eventId) {
  const { data, error } = await db().from('registration_settings').select('*').eq('event_id', eventId).single()
  if (error) throw error
  return data
}

async function rowsOf(table, eventId) {
  const { data, error } = await db().from(table).select('*').eq('event_id', eventId)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------- P-40

test('P-40 a draft saves the payment window straight away; 337, taken and payout keys are 422', async () => {
  const eventId = await draft()
  assert.equal((await settingsOf(eventId)).payment_window_hours, 168)
  for (const hours of [24, 336, 168]) {
    const r = await save(eventId, { paymentWindowHours: hours })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await settingsOf(eventId)).payment_window_hours, hours)
  }
  const bad = await save(eventId, { paymentWindowHours: 337 })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.fields.paymentWindowHours, 'Wybierz czas na opłacenie zgłoszenia.')
  for (const key of ['taken', 'payoutIban', 'payoutMode', 'payout_iban']) {
    const r = await save(eventId, { paymentWindowHours: 24, [key]: IBAN })
    assert.equal(r.status, 422, key)
    assert.ok(r.body.fields[key], key)
  }
  assert.equal((await settingsOf(eventId)).payment_window_hours, 168)
  // A member reads the wizard but never writes it.
  assert.equal((await save(eventId, { paymentWindowHours: 24 }, member)).status, 403)
})

test('P-40 the SQL refuses a window outside its check even past the validator', async () => {
  const eventId = await draft()
  const { error } = await db().rpc('save_registration_section', {
    p_event_id: eventId, p_section: 'payments', p_value: { payment_window_hours: 337 },
  })
  assert.ok(error)
  assert.equal(error.code, '23514')
  assert.equal((await settingsOf(eventId)).payment_window_hours, 168)
})

test('P-40 after publish: staged, previewed as „Czas na opłacenie zgłoszenia”, applied by publish_changes with the previewed stamp; a stale stamp is 409 changed', async () => {
  const event = await createPublishedFreeEvent(owner, { clubSlug: slug })
  const staged = await save(event.eventId, { paymentWindowHours: 336 })
  assert.equal(staged.status, 200, JSON.stringify(staged.body))
  assert.deepEqual(staged.body.data.changedFields, ['payments.payment_window_hours'])
  assert.equal((await settingsOf(event.eventId)).payment_window_hours, 168, 'nothing live changes before „Opublikuj zmiany”')

  const preview = async () => {
    const r = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'preview_changes' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.data
  }
  const seen = await preview()
  assert.deepEqual(seen.diff, [
    { field: 'payments.payment_window_hours', label: 'Czas na opłacenie zgłoszenia', before: '7 dni', after: '14 dni' },
  ])

  // Staged again after the preview: the stamp the organizer saw is stale.
  assert.equal((await save(event.eventId, { paymentWindowHours: 24 })).status, 200)
  const stale = await callFn('publish-registration-event', owner, {
    eventId: event.eventId, action: 'publish_changes', notify: { send: false }, expectedUpdatedAt: seen.updatedAt,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'changed')
  assert.equal((await settingsOf(event.eventId)).payment_window_hours, 168)

  const fresh = await preview()
  assert.equal(fresh.diff[0].after, '24 godziny')
  const ok = await callFn('publish-registration-event', owner, {
    eventId: event.eventId, action: 'publish_changes', notify: { send: false }, expectedUpdatedAt: fresh.updatedAt,
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal((await settingsOf(event.eventId)).payment_window_hours, 24)
  assert.equal((await rowsOf('registration_pending_changes', event.eventId)).length, 0)
})

test('P-40 publish_registration_changes applies a staged window on its own (no edge function)', async () => {
  const event = await createPublishedFreeEvent(owner, { clubSlug: slug })
  assert.equal((await save(event.eventId, { paymentWindowHours: 24 })).status, 200)
  const { error } = await db().rpc('publish_registration_changes', { p_event_id: event.eventId, p_actor: owner.profileId })
  assert.ifError(error)
  assert.equal((await settingsOf(event.eventId)).payment_window_hours, 24)
})

// ---------------------------------------------------------------- P-41

test('P-41 update-event-payout: an admin and a member get 403, an outsider 404, nothing is written', async () => {
  const eventId = await draft()
  for (const s of [clubAdmin, member]) {
    const r = await setPayout(eventId, CUSTOM, s)
    assert.equal(r.status, 403, JSON.stringify(r.body))
  }
  assert.equal((await setPayout(eventId, CUSTOM, outsider)).status, 404)
  assert.equal((await rowsOf('event_payout_details', eventId)).length, 0)
  assert.equal((await rowsOf('event_payout_history', eventId)).length, 0)
})

test('P-41 update-event-payout: invalid values are 400 with Plan 1\'s messages, nothing written', async () => {
  const eventId = await draft()
  const cases = [
    [{ ...CUSTOM, iban: 'PL61109010140000071219812875' }, 'Nieprawidłowy numer rachunku.'],
    [{ ...CUSTOM, iban: 'DE89370400440532013000' }, 'Nieprawidłowy numer rachunku.'],
    [{ ...CUSTOM, taxId: '5260250275' }, 'Nieprawidłowy NIP.'],
    [{ ...CUSTOM, recipient: '  ' }, 'Podaj nazwę odbiorcy.'],
    [{ ...CUSTOM, recipient: 'x'.repeat(201) }, 'Nazwa odbiorcy jest za długa (maks. 200 znaków).'],
    [{ ...CUSTOM, title: 'x'.repeat(141) }, 'Tytuł przelewu jest za długi (maks. 140 znaków).'],
    [{ ...CUSTOM, mode: 'other' }, 'Wybierz konto do wypłat.'],
  ]
  for (const [body, message] of cases) {
    const r = await setPayout(eventId, body)
    assert.equal(r.status, 400, message)
    assert.deepEqual(r.body, { error: message })
  }
  assert.equal((await rowsOf('event_payout_details', eventId)).length, 0)
})

test('P-41 the owner saves another account: normalised row, history, owner email with a masked IBAN, audit row without values', async () => {
  const eventId = await draft()
  await clearMessages()
  const r = await setPayout(eventId, CUSTOM)
  assert.equal(r.status, 200, JSON.stringify(r.body))

  const [row] = await rowsOf('event_payout_details', eventId)
  assert.equal(row.payout_mode, 'custom')
  assert.equal(row.payout_recipient, 'Fundacja Leśna Pomoc')
  assert.equal(row.payout_tax_id, NIP)
  assert.equal(row.payout_iban, IBAN)
  assert.equal(row.payout_title, 'Bieg Leszego — wpisowe')
  assert.equal(row.updated_by, owner.profileId)

  const hist = await rowsOf('event_payout_history', eventId)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].old, null)
  assert.equal(hist[0].new.payout_iban, IBAN)
  assert.equal(hist[0].changed_by, owner.profileId)

  const mails = await messagesTo(club.ownerEmail)
  assert.equal(mails.length, 1)
  assert.match(mails[0].subject, /^Zmieniono dane do wypłat zawodów Bieg Leszego [0-9a-f]{8}$/)
  assert.match(mails[0].text, /PL61 … 2874/)
  assert.doesNotMatch(mails[0].text, new RegExp(IBAN_DIGITS))

  const { data: acts } = await db().from('organizer_actions').select('*').eq('event_id', eventId).eq('action', 'event_payout_changed')
  assert.equal(acts.length, 1)
  assert.equal(acts[0].actor_id, owner.profileId)
  assert.equal(acts[0].club_id, club.clubId)
  assert.deepEqual([...acts[0].payload.fields].sort(), ['payout_iban', 'payout_mode', 'payout_recipient', 'payout_tax_id', 'payout_title'])
  assert.doesNotMatch(JSON.stringify(acts[0].payload), /PL61|5260250274|Fundacja/)

  // Back to the club account: the event's own account details are dropped, history keeps both.
  const back = await setPayout(eventId, { mode: 'club' })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  const [after_] = await rowsOf('event_payout_details', eventId)
  assert.equal(after_.payout_mode, 'club')
  assert.equal(after_.payout_iban, null)
  assert.equal(after_.payout_recipient, null)
  const hist2 = await rowsOf('event_payout_history', eventId)
  assert.equal(hist2.length, 2)
})

test('P-41 a published event takes a payout change straight away, never staged', async () => {
  const event = await createPublishedFreeEvent(owner, { clubSlug: slug })
  assert.equal((await setPayout(event.eventId, CUSTOM)).status, 200)
  assert.equal((await rowsOf('event_payout_details', event.eventId))[0].payout_iban, IBAN)
  assert.equal((await rowsOf('registration_pending_changes', event.eventId)).length, 0)
})

test('P-41 save_event_payout: anon and authenticated cannot execute it; it refuses a non-owner and an incomplete custom account', async () => {
  const eventId = await draft()
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const args = { p_event_id: eventId, p_actor: owner.profileId, p_mode: 'club', p_recipient: null, p_tax_id: null, p_iban: null, p_title: null }
  for (const [who, client] of [['anon', anon], ['authenticated', authenticatedClient()]]) {
    const { error } = await client.rpc('save_event_payout', args)
    assert.ok(error, `${who} must be refused`)
    assert.match(error.message, /permission denied for function save_event_payout/, `${who}: ${error.message}`)
  }
  const asAdmin = await db().rpc('save_event_payout', { ...args, p_actor: clubAdmin.profileId })
  assert.equal(asAdmin.error?.message, 'forbidden')
  const incomplete = await db().rpc('save_event_payout', { ...args, p_mode: 'custom', p_recipient: 'X' })
  assert.equal(incomplete.error?.message, 'invalid_payout')
  assert.equal((await rowsOf('event_payout_details', eventId)).length, 0)
})

// ---------------------------------------------------------------- reads (ruling P3-R1)

test('P-41 get-event-payout: the owner reads every field, an admin the recipient and a masked IBAN, a member 403, an outsider 404', async () => {
  const eventId = await draft()
  const none = await readPayout(eventId, owner)
  assert.equal(none.status, 200)
  assert.deepEqual(none.body.data, { mode: 'club', recipient: null, taxId: null, iban: null, title: null })

  assert.equal((await setPayout(eventId, CUSTOM)).status, 200)
  const own = await readPayout(eventId, owner)
  assert.deepEqual(own.body.data, { mode: 'custom', recipient: 'Fundacja Leśna Pomoc', taxId: NIP, iban: IBAN, title: 'Bieg Leszego — wpisowe' })

  const adm = await readPayout(eventId, clubAdmin)
  assert.equal(adm.status, 200)
  assert.deepEqual(adm.body.data, { mode: 'custom', recipient: 'Fundacja Leśna Pomoc', ibanMasked: 'PL61 … 2874' })

  const mem = await readPayout(eventId, member)
  assert.equal(mem.status, 403)
  assert.doesNotMatch(JSON.stringify(mem.body), new RegExp(IBAN_DIGITS))
  assert.equal((await readPayout(eventId, outsider)).status, 404)
})

test('P-41 no path but get-event-payout carries the event IBAN or NIP: wizard read, preview, event list, public and raw read models', async () => {
  const event = await createPublishedFreeEvent(owner, { clubSlug: slug })
  assert.equal((await setPayout(event.eventId, CUSTOM)).status, 200)
  const leaks = (body) => {
    const text = JSON.stringify(body)
    return text.includes(IBAN_DIGITS) || text.includes(NIP) || text.includes('Fundacja Leśna Pomoc')
  }

  for (const [who, s] of [['owner', owner], ['admin', clubAdmin], ['member', member]]) {
    const wizard = await callFn('get-registration-event', s, { eventId: event.eventId })
    assert.equal(wizard.status, 200, `${who}: ${JSON.stringify(wizard.body)}`)
    assert.equal(leaks(wizard.body), false, `get-registration-event as ${who}`)
    const preview = await callFn('preview-registration-event', s, { eventId: event.eventId })
    assert.equal(preview.status, 200, `${who}: ${JSON.stringify(preview.body)}`)
    assert.equal(leaks(preview.body), false, `preview-registration-event as ${who}`)
    const list = await callFn('list-club-registration-events', s, { clubId: club.clubId })
    assert.equal(list.status, 200)
    assert.equal(leaks(list.body), false, `list-club-registration-events as ${who}`)
  }

  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const pub = await anon.rpc('registration_public', { p_slug: event.slug })
  assert.ifError(pub.error)
  assert.ok(pub.data)
  assert.equal(leaks(pub.data), false, 'registration_public')
  const raw = await db().rpc('registration_raw', { p_event_id: event.eventId })
  assert.ifError(raw.error)
  assert.equal(leaks(raw.data), false, 'registration_raw')

  // The table itself is closed to the client roles.
  for (const [who, client] of [['anon', anon], ['authenticated', authenticatedClient()]]) {
    const { data, error } = await client.from('event_payout_details').select('*').eq('event_id', event.eventId)
    assert.ok(error || (data ?? []).length === 0, `${who} must not read event_payout_details`)
  }
})

// ---------------------------------------------------------------- P-42

test('P-42 a paid draft: club account without club payout details blocks; with them only the payments flag item; another valid account too', async () => {
  const own = await makeClub({ slug: `p3-pay42-${rand()}` })
  const ownerS = await sessionFor(own.ownerEmail)
  const { data: none } = await db().from('club_payout_details').select('club_id').eq('club_id', own.clubId)
  assert.equal(none.length, 0)

  const created = await callFn('create-registration-event', ownerS, { clubId: own.clubId, name: `Bieg płatny ${rand()}` })
  assert.equal(created.status, 201)
  const eventId = created.body.data.eventId
  const sec = (section, value) => callFn('save-registration-section', ownerS, { eventId, section, value })
  assert.equal((await sec('basics', {
    eventDate: '2027-03-14', opensOn: '2027-01-10', closesOn: '2027-03-12', townLabel: 'Nieborowice', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  })).status, 200)
  assert.equal((await sec('competitions', { pricingMode: 'fixed', items: [{
    name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50, price: '60',
  }] })).status, 200)

  const blocking = async () => {
    const r = await callFn('get-registration-event', ownerS, { eventId })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.data.checklist.blocking
  }
  assert.deepEqual(await blocking(), [
    { key: 'payments', label: 'Płatności online — wkrótce' },
    { key: 'payout', label: 'Uzupełnij dane do wypłat w ustawieniach klubu' },
  ])
  const refused = await callFn('publish-registration-event', ownerS, { eventId, action: 'publish' })
  assert.equal(refused.status, 409)
  assert.deepEqual(refused.body.blocking.map((b) => b.key), ['payments', 'payout'])

  const { error } = await db().from('club_payout_details').insert({
    club_id: own.clubId, legal_name: 'Klub', nip: NIP, iban: IBAN, address: 'ul. Leśna 1',
  })
  assert.ifError(error)
  assert.deepEqual(await blocking(), [{ key: 'payments', label: 'Płatności online — wkrótce' }])

  // Another account, valid: still only the flag item.
  assert.equal((await setPayout(eventId, CUSTOM, ownerS)).status, 200)
  assert.deepEqual(await blocking(), [{ key: 'payments', label: 'Płatności online — wkrótce' }])
  const again = await callFn('publish-registration-event', ownerS, { eventId, action: 'publish' })
  assert.deepEqual(again.body.blocking.map((b) => b.key), ['payments'])
})

test('P-42 an incomplete other account stored directly (no edge function) blocks a paid event', async () => {
  const eventId = await draft()
  assert.equal((await callFn('save-registration-section', owner, {
    eventId, section: 'competitions', value: { pricingMode: 'fixed', items: [{
      name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50, price: '60',
    }] },
  })).status, 200)
  const { error } = await db().from('event_payout_details').insert({ event_id: eventId, payout_mode: 'custom', payout_recipient: 'X' })
  assert.ifError(error)
  const r = await callFn('get-registration-event', owner, { eventId })
  assert.deepEqual(r.body.data.checklist.blocking.filter((b) => b.key === 'payout'),
    [{ key: 'payout', label: 'Dane do wypłat tego wydarzenia' }])
})

// ---------------------------------------------------------------- review fixes

/** A fresh club with no club payout details, its owner and admin sessions. */
async function freshClub(tag) {
  const slug_ = `p3-${tag}-${rand()}`
  const c = await makeClub({ slug: slug_ })
  const [o, a] = await Promise.all([c.ownerEmail, c.adminEmail].map(sessionFor))
  return { ...c, slug: slug_, owner: o, admin: a }
}

// M-1: a published paid event never switches to a club account that has no
// payout details: runners would pay with nowhere to pay out to.
test('M-1 a published paid event: „Konto klubu” without club payout details is 409 payout_not_ready; with them 200', async () => {
  const c = await freshClub('m1')
  const event = await createPublishedPaidEvent(c.owner, { clubSlug: c.slug })
  assert.equal((await setPayout(event.eventId, CUSTOM, c.owner)).status, 200)
  const refused = await setPayout(event.eventId, { mode: 'club' }, c.owner)
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  assert.deepEqual(refused.body, { error: 'Uzupełnij dane do wypłat w ustawieniach klubu', code: 'payout_not_ready' })
  assert.equal((await rowsOf('event_payout_details', event.eventId))[0].payout_mode, 'custom')
  assert.equal((await rowsOf('event_payout_history', event.eventId)).length, 1)

  // The RPC refuses it too, whoever calls it.
  const direct = await db().rpc('save_event_payout', {
    p_event_id: event.eventId, p_actor: c.owner.profileId, p_mode: 'club', p_recipient: null, p_tax_id: null, p_iban: null, p_title: null,
  })
  assert.equal(direct.error?.message, 'payout_not_ready')

  const { error } = await db().from('club_payout_details').insert({
    club_id: c.clubId, legal_name: 'Klub', nip: NIP, iban: IBAN, address: 'ul. Leśna 1',
  })
  assert.ifError(error)
  assert.equal((await setPayout(event.eventId, { mode: 'club' }, c.owner)).status, 200)
  assert.equal((await rowsOf('event_payout_details', event.eventId))[0].payout_mode, 'club')
})

test('M-1 a published free event with a staged paid pricing counts as paid; a draft and a free published event may pick the club account', async () => {
  const c = await freshClub('m1b')
  const event = await createPublishedFreeEvent(c.owner, { clubSlug: c.slug })
  assert.equal((await setPayout(event.eventId, { mode: 'club' }, c.owner)).status, 200, 'free and published: allowed')
  assert.equal((await setPayout(event.eventId, CUSTOM, c.owner)).status, 200)
  const staged = await callFn('save-registration-section', c.owner, { eventId: event.eventId, section: 'competitions', value: {
    pricingMode: 'fixed', items: [{ categoryId: event.categoryIds[0], name: 'Bieg 9 km', kind: 'individual', discipline: 'run',
      distanceLabel: '9 km', startTime: '10:00', capacity: 50, price: '60' }],
  } })
  assert.equal(staged.status, 200, JSON.stringify(staged.body))
  const refused = await setPayout(event.eventId, { mode: 'club' }, c.owner)
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'payout_not_ready')

  // A paid draft: the checklist blocks publish, so the choice is free.
  const created = await callFn('create-registration-event', c.owner, { clubId: c.clubId, name: `Szkic ${rand()}` })
  const draftId = created.body.data.eventId
  assert.equal((await callFn('save-registration-section', c.owner, { eventId: draftId, section: 'competitions', value: {
    pricingMode: 'fixed', items: [{ name: 'Bieg', kind: 'individual', distanceLabel: '9 km', startTime: '10:00', capacity: 5, price: '60' }],
  } })).status, 200)
  assert.equal((await setPayout(draftId, CUSTOM, c.owner)).status, 200)
  assert.equal((await setPayout(draftId, { mode: 'club' }, c.owner)).status, 200)
})

// M-3, M-10: a club without online registration.
test('M-3 M-10 a disabled club: both payout functions 404 and save_event_payout refuses', async () => {
  const c = await freshClub('m3')
  const created = await callFn('create-registration-event', c.owner, { clubId: c.clubId, name: `Bieg ${rand()}` })
  const eventId = created.body.data.eventId
  await makeClub({ slug: c.slug, enabled: false })
  assert.equal((await setPayout(eventId, CUSTOM, c.owner)).status, 404)
  assert.equal((await readPayout(eventId, c.owner)).status, 404)
  assert.equal((await readPayout(eventId, c.admin)).status, 404)
  const direct = await db().rpc('save_event_payout', {
    p_event_id: eventId, p_actor: c.owner.profileId, p_mode: 'club', p_recipient: null, p_tax_id: null, p_iban: null, p_title: null,
  })
  assert.equal(direct.error?.message, 'forbidden')
  assert.equal((await rowsOf('event_payout_details', eventId)).length, 0)
})

test('M-10 a null or non-object body is refused, never a 500', async () => {
  for (const fn of ['update-event-payout', 'get-event-payout']) {
    for (const body of [null, 'x', 7, []]) {
      const r = await callFn(fn, owner, body)
      assert.ok([400, 404].includes(r.status), `${fn} ${JSON.stringify(body)}: ${r.status}`)
    }
  }
})

// M-2: saving what is already stored writes no history and sends no email.
test('M-2 saving unchanged values: 200, no history row, no email', async () => {
  const eventId = await draft()
  assert.equal((await setPayout(eventId, CUSTOM)).status, 200)
  await clearMessages()
  const again = await setPayout(eventId, CUSTOM)
  assert.equal(again.status, 200)
  assert.deepEqual(again.body.data.changed, [])
  assert.equal((await rowsOf('event_payout_history', eventId)).length, 1)
  assert.equal((await messagesTo(club.ownerEmail)).length, 0)
})

// ---------------------------------------------------------------- P-59 „do końca zapisów”

test('P-59 a draft saves „do końca zapisów” and back; the column defaults to false; the SQL refuses a non-boolean', async () => {
  const eventId = await draft()
  assert.equal((await settingsOf(eventId)).payment_window_until_close, false)
  let r = await save(eventId, { paymentWindowUntilClose: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let s = await settingsOf(eventId)
  assert.equal(s.payment_window_until_close, true)
  assert.equal(s.payment_window_hours, 168, 'the hours stay as they were')
  r = await save(eventId, { paymentWindowHours: 24, paymentWindowUntilClose: false })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  s = await settingsOf(eventId)
  assert.deepEqual([s.payment_window_hours, s.payment_window_until_close], [24, false])
  const bad = await save(eventId, { paymentWindowUntilClose: 'tak' })
  assert.equal(bad.status, 422)
  const { error } = await db().rpc('save_registration_section', {
    p_event_id: eventId, p_section: 'payments', p_value: { payment_window_until_close: 'nie-bool' },
  })
  assert.ok(error, 'a non-boolean never reaches the column')
})

test('P-59 after publish: „do końca zapisów” is staged (changedFields), previewed in words, applied by publish_changes with expectedUpdatedAt', async () => {
  const event = await createPublishedFreeEvent(owner, { clubSlug: slug })
  const staged = await save(event.eventId, { paymentWindowUntilClose: true })
  assert.equal(staged.status, 200, JSON.stringify(staged.body))
  assert.deepEqual(staged.body.data.changedFields, ['payments.payment_window_until_close'])
  assert.equal((await settingsOf(event.eventId)).payment_window_until_close, false, 'nothing live before „Opublikuj zmiany”')
  const preview = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'preview_changes' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.data.diff, [
    { field: 'payments.payment_window_hours', label: 'Czas na opłacenie zgłoszenia', before: '7 dni', after: 'do końca zapisów' },
  ])
  const ok = await callFn('publish-registration-event', owner, {
    eventId: event.eventId, action: 'publish_changes', notify: { send: false }, expectedUpdatedAt: preview.body.data.updatedAt,
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal((await settingsOf(event.eventId)).payment_window_until_close, true)
})

test('P-59 an order on a „do końca zapisów” event expires at closes_at, even three weeks away; the reminder comes at half the window', async () => {
  const { createPublishedPaidEvent } = await import('./helpers/registrationFixtures.js')
  const { orderOk, setSettings, rpc } = await import('./helpers/orders.js')
  const event = await createPublishedPaidEvent(owner, { clubSlug: slug, prices: { 'Bieg 9 km': 6000 } })
  const closes = new Date(Date.now() + 21 * 24 * 3600e3)
  closes.setUTCSeconds(0, 0)
  await setSettings(event.eventId, { payment_window_until_close: true, closes_at: closes.toISOString() })
  const out = await orderOk(event)
  assert.equal(Date.parse(out.expiresAt), closes.getTime())
  // Not before half the window ...
  let claimed = await rpc('claim_payment_reminders', { p_limit: 1000 })
  assert.ifError(claimed.error)
  assert.ok(!claimed.data.includes(out.orderId))
  // ... and once the half has passed (created 30 days before a close 21 days away: the half was 4.5 days ago).
  const { error } = await db().from('orders').update({ created_at: new Date(Date.now() - 30 * 24 * 3600e3).toISOString() }).eq('id', out.orderId)
  assert.ifError(error)
  claimed = await rpc('claim_payment_reminders', { p_limit: 1000 })
  assert.ifError(claimed.error)
  assert.ok(claimed.data.includes(out.orderId))
})
