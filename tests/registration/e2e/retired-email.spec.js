import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import { admin } from '../helpers/stack.js'

const RETIRED_TEXT = 'Ten adres e-mail należał do usuniętego konta LESZY.RUN i nie może zostać użyty ponownie. Podaj inny adres albo napisz do nas: kontakt@leszy.run.'

test('F-16 a retired address on the login page shows the deleted-address message', async ({ page }) => {
  const email = `retired-e2e-${Date.now()}@test.local`
  const hash = crypto.createHash('sha256').update(email).digest('hex')
  const { error } = await admin().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })
  expect(error).toBeNull()

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.locator('form button[type="submit"]').click()
  await expect(page.getByText(RETIRED_TEXT, { exact: true })).toBeVisible()
  await expect(page.getByLabel('Kod (6 cyfr)')).toHaveCount(0)
})
