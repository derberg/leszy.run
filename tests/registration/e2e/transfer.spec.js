import { test, expect } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { lastCodeFor, messagesTo } from '../helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { runnerEmail, setSettings } from '../helpers/orders.js'
import { BIEG, adult, minor, orderGroupOk, registerGroup } from '../helpers/groups.js'
import { accept, enableTransfers, inviteOk, paidEntry } from '../helpers/transfers.js'

// Plan 7 task 8b: the runner's transfer pages in the browser. V-63…V-66 in
// docs/registration/scenario-matrix.md:
//   RA5  /events/:slug/zapisano      „Przekaż pakiet innej osobie →” on the rows the server allows
//   RA6  /events/:slug/przekaz/:id   the holder invites an address and can take the invite back
//   RA7  /przekazanie#<token>        the recipient takes the package (the token only in the fragment)

const ZT = '00000000-0000-4000-8000-0000000000c1'
const GONE = 'Ten link został już użyty, cofnięty albo wygasł.'
const MONEY = 'Pieniądze za pakiet rozliczacie między sobą, poza LESZY.RUN. Nie zwracamy ich ani nie przekazujemy.'
const TOKEN_RE = /\/przekazanie#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
const PIEC = { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 50 }
const DZIECI = { name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity: 50 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let owner
test.beforeAll(async () => {
  owner = await sessionFor('owner@zatyrani-test.local')
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
})
test.beforeEach(async () => { await resetThrottle() })

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return page
}

/** A browser context signed in as `email`. */
async function contextFor(browser, email) {
  const context = await browser.newContext()
  const { token } = await sessionFor(email)
  await context.addCookies([{ name: 'leszy_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }])
  return context
}

/** Nothing scrolls sideways, and no button or link label is cut or wraps. */
async function fitsNarrow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('#main-content button, #main-content a')]
    .filter((el) => el.offsetParent && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1))
    .map((el) => el.textContent.trim()))
  expect(overflowing).toEqual([])
  const wrapped = await page.locator('#main-content button:visible').evaluateAll((els) => els
    .filter((el) => el.getClientRects().length > 1 || el.getBoundingClientRect().height >= 60).map((el) => el.textContent))
  expect(wrapped).toEqual([])
}

/** A paid event (9 km and 5 km at 60 zł, kids at 20 zł) with transfers on, and one paid holder. */
async function paidHolder() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), PIEC, DZIECI], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })
  await enableTransfers(event)
  const holder = await paidEntry(event)
  return { event, holder }
}

async function waitForMail(email, re) {
  for (let i = 0; i < 40; i++) {
    const m = (await messagesTo(email)).find((x) => re.test(x.subject))
    if (m) return m
    await sleep(250)
  }
  return null
}

async function codeFor(email) {
  let code = null
  for (let i = 0; i < 40 && !code; i++) { code = await lastCodeFor(email); if (!code) await sleep(250) }
  return code
}

/** RA7's form, filled as Jan Nowak at `email`, every consent ticked. */
async function fillRecipient(page, email) {
  await page.locator('#p-first').fill('Jan')
  await page.locator('#p-last').fill('Nowak')
  await page.locator('#p-birth').fill('1988-03-04')
  await page.getByRole('button', { name: 'Mężczyzna' }).click()
  await page.locator('#p-email').fill(email)
  await page.locator('#p-phone').fill('+48600111222')
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  const n = await boxes.count()
  for (let i = 0; i < n; i++) await boxes.nth(i).check()
}

test('V-65 RA5: „Przekaż pakiet innej osobie →” on the holder\'s own row, never on the child\'s, and gone after transfer_until', async ({ browser }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  await enableTransfers(event)
  const email = runnerEmail('parent')
  const r = await registerGroup(event, [adult(event.categoryIds[0], 'self', email), minor(event.categoryIds[0], { firstName: 'Zosia' })])
  expect(r.error).toBeNull()
  const ctx = await contextFor(browser, email)
  const page = await offline(await ctx.newPage())
  await page.goto(`/events/${event.slug}/zapisano`)
  const rows = page.getByTestId('done-person')
  await expect(rows).toHaveCount(2)
  const own = rows.filter({ hasText: 'Ola Leśna' })
  const child = rows.filter({ hasText: 'Zosia' })
  const selfId = r.data.registrations.find((x) => x.role === 'self').id
  await expect(own.getByRole('link', { name: 'Przekaż pakiet innej osobie →' })).toHaveAttribute('href', `/events/${event.slug}/przekaz/${selfId}`)
  await expect(child.getByRole('link', { name: /Przekaż pakiet/ })).toHaveCount(0)

  // The organizer's last day has passed: the server says no, and the page shows nothing.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await setSettings(event.eventId, { transfer_until: yesterday })
  await page.reload()
  await expect(rows).toHaveCount(2)
  await expect(page.getByRole('link', { name: /Przekaż pakiet/ })).toHaveCount(0)
  await ctx.close()
})

test('V-63, V-64, V-66 RA6 → RA7 at 390 px: invite, take back, invite again; two recipients open the link, the first takes the package, the second gets the gone copy', async ({ browser }) => {
  const { event, holder } = await paidHolder()
  const regId = holder.reg.id

  // ---- RA6: the holder
  const hctx = await contextFor(browser, holder.email)
  const ra6 = await offline(await hctx.newPage())
  await ra6.setViewportSize({ width: 390, height: 844 })
  await ra6.goto(`/events/${event.slug}/zapisano`)
  await ra6.getByRole('link', { name: 'Przekaż pakiet innej osobie →' }).click()
  await expect(ra6).toHaveURL(new RegExp(`/events/${event.slug}/przekaz/${regId}$`))
  const page6 = ra6.getByTestId('transfer-invite')
  await expect(page6).toBeVisible()
  await expect(page6.getByTestId('transfer-money')).toHaveText(MONEY)
  const until = (await admin().from('registration_settings').select('transfer_until').eq('event_id', event.eventId).single()).data.transfer_until
  const [, mm, dd] = until.split('-').map(Number)
  await expect(page6).toContainText(`MOŻLIWE DO ${dd}.${String(mm).padStart(2, '0')} · BEZ OPŁATY`)
  await fitsNarrow(ra6)

  // A refusal is in Polish, under the field.
  await ra6.getByLabel('E-mail osoby, która przejmie pakiet').fill(holder.email)
  await ra6.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(ra6.getByTestId('transfer-email-error')).toHaveText('To jest adres osoby, która ma ten pakiet.')
  await expect(ra6.getByLabel('E-mail osoby, która przejmie pakiet')).toHaveAttribute('aria-describedby', 'transfer-email-error')

  const first = runnerEmail('first')
  await ra6.getByLabel('E-mail osoby, która przejmie pakiet').fill(first)
  await ra6.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(ra6.getByTestId('transfer-pending')).toContainText(`Czeka na ${first}`)
  await fitsNarrow(ra6)
  await ra6.getByRole('button', { name: 'Cofnij zaproszenie' }).click()
  await expect(ra6.getByLabel('E-mail osoby, która przejmie pakiet')).toBeVisible()
  const firstMail = await waitForMail(first, /przekazuje Ci start/)
  const deadToken = firstMail.text.match(TOKEN_RE)[1]

  const recipient = runnerEmail('jan')
  await ra6.getByLabel('E-mail osoby, która przejmie pakiet').fill(recipient)
  await ra6.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(ra6.getByTestId('transfer-pending')).toContainText(`Czeka na ${recipient}`)
  const mail = await waitForMail(recipient, /przekazuje Ci start/)
  const token = mail.text.match(TOKEN_RE)[1]

  // ---- RA7: a cancelled link is gone at once
  const dead = await offline(await (await browser.newContext()).newPage())
  await dead.setViewportSize({ width: 390, height: 844 })
  await dead.goto(`/przekazanie#${deadToken}`)
  await expect(dead.getByTestId('transfer-gone')).toContainText(GONE)
  await expect(dead).toHaveURL(/\/przekazanie$/)
  await fitsNarrow(dead)

  // ---- RA7: two people hold the live link (it was forwarded)
  const seen = []
  const ctxA = await browser.newContext()
  const a = await offline(await ctxA.newPage())
  await a.setViewportSize({ width: 390, height: 844 })
  a.on('request', (r) => seen.push(`${r.url()} ${r.headers().referer ?? ''}`))
  const hashAtFirstCall = []
  await a.route('**/edge/transfer-accept', async (route) => {
    if (hashAtFirstCall.length === 0) hashAtFirstCall.push(await a.evaluate(() => window.location.href))
    await route.continue()
  })
  await a.goto(`/przekazanie#${token}`)
  const formA = a.getByTestId('transfer-accept')
  await expect(formA).toBeVisible()
  await expect(a).toHaveURL(/\/przekazanie$/)
  expect(hashAtFirstCall[0]).toMatch(/\/przekazanie$/)
  await expect(formA).toContainText('Ola')
  await expect(formA).not.toContainText('Leśna')
  await expect(formA.getByLabel('Konkurencja · w tej samej cenie (60 zł)')).toBeVisible()
  const options = await formA.getByLabel('Konkurencja · w tej samej cenie (60 zł)').locator('option').allTextContents()
  expect(options.join('|')).toContain('Bieg 9 km')
  expect(options.join('|')).toContain('Bieg 5 km')
  expect(options.join('|')).not.toContain('dzieci')
  await expect(formA.getByTestId('transfer-due')).toHaveText('Do zapłaty: 0 zł.')
  await expect(formA).not.toContainText('PAKIET OPŁACONY')
  await fitsNarrow(a)

  const ctxB = await browser.newContext()
  const b = await offline(await ctxB.newPage())
  await b.setViewportSize({ width: 390, height: 844 })
  await b.goto(`/przekazanie#${token}`)
  await expect(b.getByTestId('transfer-accept')).toBeVisible()

  // A takes it: the form, the code, done.
  await formA.getByLabel('Konkurencja · w tej samej cenie (60 zł)').selectOption(event.categoryIds[1])
  await fillRecipient(a, recipient)
  await a.getByRole('button', { name: 'Przyjmij pakiet' }).click()
  const code = await codeFor(recipient)
  expect(code).toMatch(/^\d{6}$/)
  await a.locator('#reg-code').fill(code)
  await a.getByRole('button', { name: 'Przyjmij pakiet' }).click()
  await expect(a.getByTestId('transfer-done')).toBeVisible()
  await fitsNarrow(a)
  const { data: moved } = await admin().from('registrations').select('status, category_id').eq('event_id', event.eventId).eq('email', recipient)
  expect(moved).toEqual([{ status: 'confirmed', category_id: event.categoryIds[1] }])
  for (const line of seen) expect(line).not.toContain(token)

  // B, still on the form, tries too: the gone copy.
  const other = runnerEmail('drugi')
  await fillRecipient(b, other)
  await b.getByRole('button', { name: 'Przyjmij pakiet' }).click()
  await expect(b.getByTestId('transfer-gone')).toContainText(GONE)
  // And the link opened again later is gone straight away.
  const again = await offline(await ctxB.newPage())
  await again.goto(`/przekazanie#${token}`)
  await expect(again.getByTestId('transfer-gone')).toContainText(GONE)

  // RA6 after the hand-over: the holder's page no longer offers anything.
  await ra6.reload()
  await expect(ra6.getByTestId('transfer-unavailable')).toBeVisible()
  await Promise.all([hctx.close(), ctxA.close(), ctxB.close()])
})

test('V-66 RA7 after registration closed shows the closed badge, and a session on the address needs no code', async ({ browser }) => {
  const { event, holder } = await paidHolder()
  const recipient = runnerEmail('zamkniete')
  const hctx = await contextFor(browser, holder.email)
  const ra6 = await offline(await hctx.newPage())
  await ra6.goto(`/events/${event.slug}/przekaz/${holder.reg.id}`)
  await ra6.getByLabel('E-mail osoby, która przejmie pakiet').fill(recipient)
  await ra6.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(ra6.getByTestId('transfer-pending')).toBeVisible()
  const token = (await waitForMail(recipient, /przekazuje Ci start/)).text.match(TOKEN_RE)[1]
  await setSettings(event.eventId, { closes_at: new Date(Date.now() - 60_000).toISOString() })

  const rctx = await contextFor(browser, recipient)
  const page = await offline(await rctx.newPage())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/przekazanie#${token}`)
  await expect(page.getByTestId('transfer-closed')).toHaveText('PAKIET OPŁACONY · ZAPISY ZAMKNIĘTE, ALE TEN LINK DZIAŁA')
  await fitsNarrow(page)
  await fillRecipient(page, recipient)
  await page.getByRole('button', { name: 'Przyjmij pakiet' }).click()
  await expect(page.getByTestId('transfer-done')).toBeVisible()
  await expect(page.locator('#reg-code')).toHaveCount(0)
  await Promise.all([hctx.close(), rctx.close()])
})

test('carry T8 (e): an unpaid order replaced by an accepted package says why on the order page, with no „Zapisz się ponownie”', async ({ browser }) => {
  const { event, holder } = await paidHolder()
  const recipient = runnerEmail('zamiana')
  const pendingOrder = await orderGroupOk(event, [adult(event.categoryIds[0], 'self', recipient)])
  const inv = await inviteOk(holder.reg.id, holder.profileId, recipient)
  const done = await accept(event, inv.hash, { email: recipient })
  expect(done.error).toBeNull()

  const ctx = await contextFor(browser, recipient)
  const page = await offline(await ctx.newPage())
  await page.goto(`/zamowienie/${pendingOrder.orderId}`)
  const ended = page.getByTestId('order-ended')
  await expect(ended).toContainText('Przejąłeś(-ęłaś) pakiet od innej osoby, więc to nieopłacone zgłoszenie anulowaliśmy.')
  await expect(page.getByTestId('order-again')).toHaveCount(0)
  await expect(page.getByTestId('order-own-entry')).toHaveAttribute('href', `/events/${event.slug}/zapisano`)
  await ctx.close()
})
