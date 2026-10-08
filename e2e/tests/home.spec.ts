import { expect, test } from '@playwright/test'

import { expectNoSidewaysScroll, playAs, world } from '../support/phone'

test.describe('homepage on a phone', () => {
  test('fits the screen for a guest and lists the matches', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(world.matchName).first()).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('home.png'), fullPage: true })
  })

  test('opens the account panel inside the screen', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Accesso e registrazione' }).click()
    const panel = page.getByRole('dialog')
    await expect(panel).toBeVisible()
    const box = await panel.boundingBox()
    const viewport = page.viewportSize()!
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    // Both ways in are reachable, and the form can be filled.
    await expect(panel.getByRole('tab', { name: 'Accedi' })).toBeVisible()
    await panel.getByLabel('Nome utente').fill('qualcuno')
    await expect(panel.getByLabel('Nome utente')).toHaveValue('qualcuno')
    await expectNoSidewaysScroll(page)
  })

  test('takes a player to their match', async ({ page, context }) => {
    await playAs(context, 'anna')
    await page.goto('/')
    // Their matches come first, each with the way in.
    await page
      .getByRole('listitem')
      .filter({ hasText: world.matchName })
      .getByRole('link', { name: 'Entra' })
      .first()
      .click()
    await expect(page).toHaveURL(new RegExp(`/partite/${world.matchId}$`))
    await expect(page.getByRole('tab', { name: 'Mappa' })).toBeVisible()
  })

  test('says so when a page does not exist', async ({ page }) => {
    await page.goto('/non-esiste')
    await expect(page.getByText('Pagina non trovata')).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})

test.describe('in English', () => {
  // A browser set to English gets the interface in English without asking.
  test.use({ locale: 'en-GB' })

  test('greets an English browser in English and lets it go back to Italian', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached()
    await expectNoSidewaysScroll(page)

    await page.getByRole('button', { name: 'Sign in and registration' }).click()
    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'Italiano' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'it')
    await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeAttached()
    // The choice outlives a reload.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'it')
  })

  test('shows a match in English inside the screen', async ({ page, context }) => {
    await playAs(context, 'anna')
    await page.goto(`/partite/${world.matchId}`)
    await expect(page.getByRole('tab', { name: 'Map', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Panel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Leaderboard', exact: true })).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('english.png'), fullPage: true })
  })
})
