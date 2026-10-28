import { test, expect } from './fixtures.js'
import { admin } from '../helpers/stack.js'
import { messagesTo, clearMessages } from '../helpers/emailCapture.js'

const OPERATOR = 'operator@leszy.test' // PIPELINE_ALERT_EMAIL in functions.env
const ZT = '00000000-0000-4000-8000-0000000000c1' // registration enabled
const IK = '00000000-0000-4000-8000-0000000000c2' // registration not enabled

// Every row these tests create, so the spec can run again on the same stack
// and the node tests still find both clubs in their seed state.
async function reset() {
  const db = admin()
  await db.from('registration_waitlist').delete().in('club_id', [ZT, IK])
  await db.from('organizer_agreements').delete().in('club_id', [ZT, IK])
  await db.from('club_payout_details').delete().eq('club_id', ZT)
  await db.from('club_payout_history').delete().eq('club_id', ZT)
  await db.from('organizer_actions').delete().in('club_id', [ZT, IK])
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { await reset(); await clearMessages() })
test.afterAll(reset)

async function open(context, path) {
  const page = await context.newPage()
  await page.goto(path)
  return page
}

test('F-20 inny-klub: a member sees one line, the admin sees the waitlist copy and joins, the operator is emailed', async ({ actors }) => {
  const member = await open(actors.innyMember, '/klub/inny-klub/wydarzenia')
  await expect(member.getByText('Ten klub jeszcze nie organizuje żadnych wydarzeń.')).toBeVisible()
  await expect(member.getByTestId('waitlist')).toHaveCount(0)
  await expect(member.getByRole('heading', { name: 'Zapisy online na LESZY.RUN' })).toHaveCount(0)
  await expect(member.getByText('Organizujesz zawody?')).toHaveCount(0)
  await expect(member.getByText('Chcesz ruszyć wcześniej?')).toHaveCount(0)
  await expect(member.getByTestId('klub-wydarzenia').getByText('784 640 977')).toHaveCount(0)
  await expect(member.getByTestId('klub-wydarzenia').getByRole('link', { name: /784/ })).toHaveCount(0)
  await expect(member.getByRole('button', { name: 'Dopisz klub do listy oczekujących' })).toHaveCount(0)

  const adm = await open(actors.innyAdmin, '/klub/inny-klub/wydarzenia')
  await expect(adm.getByRole('heading', { name: 'Zapisy online na LESZY.RUN' })).toBeVisible()
  await expect(adm.getByText('Organizujesz zawody? Niedługo przeprowadzisz je tutaj od początku do końca: zapisy, płatności, lista startowa i pomiar czasu.')).toBeVisible()
  await expect(adm.getByText('Na razie włączamy zapisy klubom po kolei. Płatności i obsługa zawodów to realne koszty, a LESZY.RUN prowadzi mały zespół, więc najpierw chcemy mieć pewność, że wszystko działa, jak trzeba.')).toBeVisible()
  await expect(adm.getByTestId('waitlist').getByRole('link', { name: '+48 784 640 977' })).toHaveAttribute('href', 'tel:+48784640977')
  await expect(adm.getByText('Ten klub jeszcze nie organizuje żadnych wydarzeń.')).toHaveCount(0)
  await expect(adm.getByText('Chcesz ruszyć wcześniej? Zadzwoń:')).toBeVisible()
  await adm.getByRole('button', { name: 'Dopisz klub do listy oczekujących' }).click()
  await expect(adm.getByText('Klub jest na liście. Odezwiemy się, gdy przyjdzie jego kolej.')).toBeVisible()
  await expect(adm.getByRole('button', { name: 'Dopisz klub do listy oczekujących' })).toHaveCount(0)

  await expect.poll(async () => (await messagesTo(OPERATOR)).length).toBe(1)
  expect((await messagesTo(OPERATOR))[0].subject).toBe('[Zapisy] Lista oczekujących: Inny Klub')

  // The owner opening the tab later sees the club already on the list.
  const owner = await open(actors.innyOwner, '/klub/inny-klub/wydarzenia')
  await expect(owner.getByText('Klub jest na liście. Odezwiemy się, gdy przyjdzie jego kolej.')).toBeVisible()
  await expect(owner.getByRole('button', { name: 'Dopisz klub do listy oczekujących' })).toHaveCount(0)
})

test('F-20 inny-klub: no payout section and no agreement while the club is not enabled', async ({ actors }) => {
  for (const actor of [actors.innyOwner, actors.innyAdmin]) {
    const settings = await actor.newPage()
    const statusRead = settings.waitForResponse((r) => r.url().includes('/organizer-status'))
    await settings.goto('/klub/inny-klub/ustawienia')
    expect((await (await statusRead).json()).data.enabled).toBe(false)
    await expect(settings.getByTestId('save-club')).toBeVisible()
    await expect(settings.getByText('Dane do wypłat')).toHaveCount(0)
    await expect(settings.getByTestId('payout-details')).toHaveCount(0)
    await expect(settings.getByLabel('Numer rachunku', { exact: true })).toHaveCount(0)

    const umowa = await open(actor, '/klub/inny-klub/wydarzenia/umowa')
    await expect(umowa).toHaveURL(/\/klub\/inny-klub\/wydarzenia$/)
    await expect(umowa.getByTestId('waitlist')).toBeVisible()
    await expect(umowa.getByTestId('organizer-agreement')).toHaveCount(0)
    await expect(umowa.getByRole('button', { name: 'Akceptuję umowę' })).toHaveCount(0)
    await expect(umowa.getByRole('link', { name: 'Umowa organizatora' })).toHaveCount(0)
  }
  const { data } = await admin().from('organizer_agreements').select('id').eq('club_id', IK)
  expect(data.length).toBe(0)
})

test('F-20 zatyrani-test: the owner accepts the agreement, then owner and admin get the new-event button', async ({ actors }) => {
  const adm = await open(actors.admin, '/klub/zatyrani-test/wydarzenia')
  await expect(adm.getByText('Umowę akceptuje właściciel klubu')).toBeVisible()
  await expect(adm.getByRole('button', { name: /Nowe wydarzenie/ })).toHaveCount(0)

  const member = await open(actors.member, '/klub/zatyrani-test/wydarzenia')
  await expect(member.getByRole('navigation', { name: 'Sekcje klubu' }).getByRole('link', { name: 'Wydarzenia' })).toBeVisible()
  await expect(member.getByRole('heading', { name: 'Wydarzenia klubu' })).toBeVisible()
  await expect(member.getByTestId('klub-wydarzenia').getByRole('button')).toHaveCount(0)
  await expect(member.getByText('Ten klub jeszcze nie organizuje żadnych wydarzeń.')).toBeVisible()
  await expect(member.getByTestId('waitlist')).toHaveCount(0)
  await expect(member.getByTestId('klub-wydarzenia').getByText('784 640 977')).toHaveCount(0)
  await expect(member.getByText('Umowę akceptuje właściciel klubu')).toHaveCount(0)

  const owner = await open(actors.owner, '/klub/zatyrani-test/wydarzenia')
  await owner.getByRole('link', { name: 'Umowa organizatora' }).click()
  await expect(owner).toHaveURL(/\/klub\/zatyrani-test\/wydarzenia\/umowa$/)
  await owner.getByRole('button', { name: 'Akceptuję umowę' }).click()
  await expect(owner).toHaveURL(/\/klub\/zatyrani-test\/wydarzenia$/)
  await expect(owner.getByRole('button', { name: '+ Nowe wydarzenie' })).toBeEnabled()

  await adm.reload()
  const wizard = adm.getByRole('button', { name: '+ Nowe wydarzenie' })
  await expect(wizard).toBeEnabled()
  await expect(wizard).not.toContainText('wkrótce')
  await expect(adm.getByText('Umowę akceptuje właściciel klubu')).toHaveCount(0)

  // A member never gets the button, before or after the agreement.
  await member.reload()
  await expect(member.getByRole('heading', { name: 'Wydarzenia klubu' })).toBeVisible()
  await expect(member.getByRole('button', { name: /Nowe wydarzenie/ })).toHaveCount(0)
})

test('F-20 zatyrani-test: the owner saves payout details, the admin sees the masked account', async ({ actors }) => {
  const owner = await open(actors.owner, '/klub/zatyrani-test/ustawienia')
  await owner.getByLabel('Nazwa podmiotu', { exact: true }).fill('Stowarzyszenie Zatyrani Test')
  await owner.getByLabel('NIP', { exact: true }).fill('526-025-02-74')
  await owner.getByLabel('KRS', { exact: true }).fill('0000123456')
  await owner.getByLabel('Numer rachunku', { exact: true }).fill('PL61 1090 1014 0000 0712 1981 2874')
  await owner.getByLabel('Adres', { exact: true }).fill('ul. Leśna 1, 00-001 Warszawa')
  await owner.getByRole('button', { name: 'Zapisz dane do wypłat' }).click()
  await expect(owner.getByTestId('payout-saved')).toBeVisible()

  await owner.reload()
  // Shown in 4-character groups; the stored value is normalized (checked below).
  await expect(owner.getByLabel('Numer rachunku', { exact: true })).toHaveValue('PL61 1090 1014 0000 0712 1981 2874')
  const { data: stored } = await admin().from('club_payout_details').select('iban').eq('club_id', ZT).single()
  expect(stored.iban).toBe('PL61109010140000071219812874')

  const adm = await open(actors.admin, '/klub/zatyrani-test/ustawienia')
  const section = adm.getByTestId('payout-details')
  await expect(section.getByText('PL61 … 2874')).toBeVisible()
  await expect(section.getByText('Stowarzyszenie Zatyrani Test')).toBeVisible()
  await expect(section.getByRole('textbox')).toHaveCount(0)
  await expect(adm.getByText('109010140000071219812874')).toHaveCount(0)
})

test('F-20 a wrong account number shows the server message and saves nothing', async ({ actors }) => {
  const owner = await open(actors.owner, '/klub/zatyrani-test/ustawienia')
  await expect(owner.getByLabel('Numer rachunku', { exact: true })).toHaveValue('PL61 1090 1014 0000 0712 1981 2874')
  await owner.getByLabel('Numer rachunku', { exact: true }).fill('PL61109010140000071219812875')
  await owner.getByRole('button', { name: 'Zapisz dane do wypłat' }).click()
  await expect(owner.getByText('Nieprawidłowy numer rachunku.')).toBeVisible()
  const { data } = await admin().from('club_payout_details').select('iban').eq('club_id', ZT).single()
  expect(data.iban).toBe('PL61109010140000071219812874')
})
