import { expect, test } from '@playwright/test'

import { expectNoSidewaysScroll, expectTappable, playAs, world } from '../support/phone'

test.describe('homepage on a phone', () => {
  test('opens on the demonstration, with what the game is and the matches underneath', async ({
    page,
  }) => {
    await page.goto('/')
    const hero = page.getByRole('region', { name: 'Dimostrazione del gioco sulla mappa' })
    await expect(hero).toBeVisible()
    await expect(hero.getByText('Dimostrazione: imperi inventati')).toBeVisible()
    // The map takes the top of the screen, as wide as the screen.
    const viewport = page.viewportSize()!
    const box = (await hero.boundingBox())!
    expect(box.width).toBeGreaterThan(viewport.width - 2)
    expect(box.height).toBeGreaterThan(viewport.height * 0.4)

    // It plays by itself: the chronicle fills with what the made-up empires do.
    const chronicle = hero.getByRole('list', { name: 'Cronaca della dimostrazione' })
    await expect(chronicle.getByRole('listitem').first()).toContainText(
      /ha annesso|ha conquistato|ha difeso/,
      { timeout: 30_000 },
    )

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(world.matchName).first()).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('home.png'), fullPage: true })
  })

  test('sends a guest from the hero to the sign-in page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Accedi per giocare' }).click()
    // A page of its own for signing in and registering, inside the screen.
    await expect(page).toHaveURL(/\/accesso$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Entra in Looters' })).toBeVisible()
    await page.getByRole('tab', { name: 'Registrati' }).click()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('accesso.png'), fullPage: true })
  })

  test('offers a player to create a match, and shows the matches as cards in a row', async ({
    page,
    context,
  }) => {
    await playAs(context, 'anna')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Crea una partita' })).toBeVisible()
    const row = page.getByRole('region', { name: 'Partite in corso' }).getByRole('list')
    await expect(row.getByRole('listitem').first()).toBeVisible()
    // The row scrolls sideways by itself: the page does not.
    const sideways = await row.evaluate((list) => list.scrollWidth >= list.clientWidth)
    expect(sideways).toBe(true)
    await expectNoSidewaysScroll(page)
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
