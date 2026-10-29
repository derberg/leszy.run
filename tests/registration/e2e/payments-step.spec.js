import crypto from 'node:crypto'
import path from 'node:path'
import { test, expect } from './fixtures.js'
import { admin, sessionFor } from '../helpers/stack.js'
import { callFn, makeClub } from '../helpers/registrationFixtures.js'

// Plan 3 task 8, P-43: the Płatności step of a paid event is A6 (not the
// Dodatki placeholder), the publish checklist's payout item points to it, the
// owner sets another payout account there, and an admin sees it masked.
// SCREENSHOT_DIR, when set, receives the review screenshots (1440 and 390 px).
// Playwright loads the Deno-side modules as CommonJS, so nothing here imports
// supabase/functions/_shared.

const IBAN_GROUPED = 'PL61 1090 1014 0000 0712 1981 2874'
const SHOTS = process.env.SCREENSHOT_DIR

async function contextFor(browser, email) {
  const context = await browser.newContext()
  const { token } = await sessionFor(email)
  await context.addCookies([{
    name: 'leszy_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
  }])
  return context
}

async function shoot(page, name) {
  if (!SHOTS) return
  const decline = page.getByRole('button', { name: 'Odrzuć' })
  if (await decline.isVisible()) await decline.click()
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(150)
    // No horizontal page scroll and no wrapped button at either width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: path.join(SHOTS, `8-${name}-po-${width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
}

async function payoutRow(eventId) {
  const { data, error } = await admin().from('event_payout_details').select('*').eq('event_id', eventId).maybeSingle()
  if (error) throw error
  return data
}

test('P-43 Płatności renders A6; the payout checklist item opens it; the owner sets another account, an admin sees it masked', async ({ browser }) => {
  test.setTimeout(120_000)
  const slug = `p43-${crypto.randomBytes(3).toString('hex')}`
  // Playwright cannot load the agreement version module: accept through the edge functions.
  const club = await makeClub({ slug, agreement: false })
  const owner = await sessionFor(club.ownerEmail)
  const status = await callFn('organizer-status', owner, { clubId: club.clubId })
  expect((await callFn('accept-organizer-agreement', owner, { clubId: club.clubId, version: status.body.data.version })).status).toBe(200)
  const created = await callFn('create-registration-event', owner, { clubId: club.clubId, name: 'Bieg Leszego płatny' })
  expect(created.status).toBe(201)
  const eventId = created.body.data.eventId
  const save = async (section, value) => expect((await callFn('save-registration-section', owner, { eventId, section, value })).status).toBe(200)
  await save('basics', {
    eventDate: '2027-03-14', opensOn: '2027-01-10', closesOn: '2027-03-12', townLabel: 'Nieborowice', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  })
  await save('competitions', { pricingMode: 'fixed', items: [{
    name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50, price: '60',
  }] })

  const ownerCtx = await contextFor(browser, club.ownerEmail)
  const page = await ownerCtx.newPage()
  const base = `/klub/${slug}/wydarzenia/${eventId}`

  // A7: the payout item points to Płatności.
  await page.goto(`${base}/publikacja`)
  const item = page.getByTestId('blocking-item').filter({ hasText: 'Uzupełnij dane do wypłat w ustawieniach klubu' })
  await expect(item).toBeVisible()
  await expect(page.getByTestId('blocking-item').filter({ hasText: 'Płatności online — wkrótce' })).toBeVisible()
  await expect(item.getByRole('link')).toHaveAttribute('href', `${base}/platnosci`)
  await shoot(page, 'publikacja-paid')

  await item.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`${base}/platnosci$`))
  await expect(page.getByTestId('platnosci-step')).toBeVisible()
  await expect(page.getByTestId('soon')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Czas na opłacenie zgłoszenia' })).toBeVisible()
  await expect(page.getByText('KLUB DOSTAJE 100% OPŁAT STARTOWYCH, DODATKÓW I DAROWIZN')).toBeVisible()
  await expect(page.getByTestId('club-payout-missing')).toBeVisible()

  // The window autosaves into the draft.
  await page.getByRole('radio', { name: '24 godziny' }).click()
  await expect.poll(async () => {
    const { data } = await admin().from('registration_settings').select('payment_window_hours').eq('event_id', eventId).single()
    return data.payment_window_hours
  }, { timeout: 15_000 }).toBe(24)
  await shoot(page, 'platnosci-club-owner')

  // P-59: „do końca zapisów”, with the tooltip explaining what an unpaid entry means.
  const windowRow = async () => {
    const { data } = await admin().from('registration_settings')
      .select('payment_window_hours, payment_window_until_close').eq('event_id', eventId).single()
    return data
  }
  await page.getByRole('radio', { name: 'do końca zapisów' }).click()
  await expect(page.getByRole('radio', { name: 'do końca zapisów' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(windowRow, { timeout: 15_000 }).toEqual({ payment_window_hours: 24, payment_window_until_close: true })
  const tip = page.getByTestId('payment-window-tip')
  await expect(tip).toHaveCount(0)
  await page.getByRole('button', { name: 'Co oznacza czas na opłacenie' }).click()
  await expect(tip).toHaveText('Jeśli zgłoszenie nie zostanie opłacone w tym czasie, wygasa i znika z listy zapisanych. Nieopłacone zgłoszenie nie zajmuje miejsca — limit liczy tylko opłacone.')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    // Every choice on one line: a wrapped label would make its button taller than the others.
    const heights = await page.getByRole('radiogroup', { name: 'Czas na opłacenie zgłoszenia' }).getByRole('radio')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    expect(new Set(heights).size, JSON.stringify(heights)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  await page.getByRole('radio', { name: '7 dni' }).click()
  await expect.poll(windowRow, { timeout: 15_000 }).toEqual({ payment_window_hours: 168, payment_window_until_close: false })

  // Another account, owner only.
  await page.getByRole('radio', { name: 'Inne konto' }).click()
  await page.getByLabel('Odbiorca').fill('Fundacja Leśna Pomoc')
  await page.getByLabel('NIP').fill('5260250274')
  await page.getByLabel('Numer rachunku').fill('PL61109010140000071219812874')
  await page.getByLabel('Tytuł przelewu · opcjonalnie').fill('Bieg Leszego — wpisowe')
  await page.getByRole('button', { name: 'Zapisz konto do wypłat' }).click()
  await expect(page.getByTestId('event-payout-saved')).toBeVisible()
  await expect.poll(async () => (await payoutRow(eventId))?.payout_iban).toBe('PL61109010140000071219812874')
  await expect(page.getByLabel('Numer rachunku')).toHaveValue(IBAN_GROUPED)
  await shoot(page, 'platnosci-custom-owner')

  // The checklist no longer asks for the payout.
  await page.goto(`${base}/publikacja`)
  await expect(page.getByTestId('blocking-item').filter({ hasText: 'Płatności online — wkrótce' })).toBeVisible()
  await expect(page.getByTestId('blocking-item').filter({ hasText: 'wypłat' })).toHaveCount(0)

  // An admin sees the account masked and cannot change it.
  const adminCtx = await contextFor(browser, club.adminEmail)
  const adm = await adminCtx.newPage()
  await adm.goto(`${base}/platnosci`)
  const masked = adm.getByTestId('event-payout-masked')
  await expect(masked).toContainText('Fundacja Leśna Pomoc')
  await expect(masked).toContainText('PL61 … 2874')
  await expect(adm.getByTestId('event-payout')).not.toContainText('109010140000071219812874')
  await expect(adm.getByRole('button', { name: 'Zapisz konto do wypłat' })).toHaveCount(0)
  await expect(adm.getByRole('radio', { name: 'Konto klubu' })).toBeDisabled()
  await shoot(adm, 'platnosci-custom-admin')

  // A member reads the step without the payout at all.
  const memberCtx = await contextFor(browser, club.memberEmail)
  const mem = await memberCtx.newPage()
  await mem.goto(`${base}/platnosci`)
  await expect(mem.getByTestId('platnosci-step')).toBeVisible()
  await expect(mem.getByTestId('event-payout')).toHaveCount(0)
  await expect(mem.getByText('Konto do wypłat')).toHaveCount(0)

  // Back to the club account once the club has payout details.
  const { error } = await admin().from('club_payout_details').insert({
    club_id: club.clubId, legal_name: `Klub ${slug}`, nip: '5260250274', iban: 'PL61109010140000071219812874', address: 'ul. Leśna 1',
  })
  if (error) throw error
  await page.goto(`${base}/platnosci`)
  await page.getByRole('radio', { name: 'Konto klubu' }).click()
  await page.getByRole('button', { name: 'Zapisz konto do wypłat' }).click()
  await expect(page.getByTestId('event-payout-saved')).toBeVisible()
  await expect(page.getByTestId('club-payout')).toContainText('PL61 … 2874')
  await expect.poll(async () => (await payoutRow(eventId))?.payout_mode).toBe('club')
  await shoot(page, 'platnosci-club-owner-filled')
  await adm.goto(`${base}/platnosci`)
  await expect(adm.getByTestId('club-payout')).toContainText('PL61 … 2874')
  await shoot(adm, 'platnosci-club-admin')

  await Promise.all([ownerCtx.close(), adminCtx.close(), memberCtx.close()])
})
