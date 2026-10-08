import { expect, test } from '@playwright/test'

import {
  expectNoSidewaysScroll,
  expectTappable,
  mapDrawn,
  matchUrl,
  phoneTab,
  playAs,
  world,
} from '../support/phone'

test.describe('a match on a phone', () => {
  test.beforeEach(async ({ context, page }) => {
    await playAs(context, 'anna')
    await page.goto(matchUrl())
  })

  test('opens on the map, which fills the screen above the three tabs', async ({ page }) => {
    await mapDrawn(page)
    await expect(phoneTab(page, 'Mappa')).toHaveAttribute('aria-selected', 'true')
    for (const name of ['Mappa', 'Pannello', 'Bacheca'] as const) {
      await expect(phoneTab(page, name)).toBeVisible()
    }
    await expectTappable(page, ['Mappa', 'Pannello', 'Bacheca'])

    // The tabs stay at the bottom edge and the map takes most of what is above.
    const viewport = page.viewportSize()!
    const tabs = await phoneTab(page, 'Mappa').boundingBox()
    expect(tabs!.y + tabs!.height).toBeGreaterThan(viewport.height - 2)
    const canvas = await page.locator('canvas.maplibregl-canvas').boundingBox()
    expect(canvas!.width).toBeGreaterThan(viewport.width - 2)
    expect(canvas!.height).toBeGreaterThan(viewport.height * 0.6)

    // The bar on top says where the match is, without wrapping out of the screen.
    await expect(page.getByRole('banner')).toContainText('Turno')
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('map.png') })
  })

  test('shows every page of the panel inside the screen', async ({ page }) => {
    await mapDrawn(page)
    await phoneTab(page, 'Pannello').click()
    const menu = page.getByRole('navigation', { name: 'Menu', exact: true })
    await expect(menu).toBeVisible()
    await expectNoSidewaysScroll(page)

    const pages: [entry: string, heading: string | RegExp][] = [
      ['La partita', 'Il tuo impero'],
      ['Classifica', 'Classifica'],
      ['Scontri', 'Scontri'],
      ['Storico dei turni', 'Storico dei turni'],
      ['Risorse per comune', /Risorse/],
      ['Unisci territori', /Unisci/],
      ['Costruzioni', 'Costruzioni'],
      ['Alleanze', 'Alleanze'],
    ]
    for (const [entry, heading] of pages) {
      await menu.getByRole('button', { name: entry, exact: true }).click()
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
      await expectNoSidewaysScroll(page)
      await page.screenshot({
        path: test.info().outputPath(`panel-${entry.replaceAll(' ', '-')}.png`),
        fullPage: true,
      })
      // The way back is always there and big enough for a finger.
      await expectTappable(page, [/^menu$/i])
      await page.getByRole('button', { name: /^menu$/i }).click()
      await expect(menu).toBeVisible()
    }
  })

  test('finds a municipality by name and annexes it, without touching the map', async ({ page }) => {
    // The two screen sizes play the same match: each annexes a neighbour of its own.
    const projects = test.info().config.projects.map((project) => project.name)
    const target = world.freeNeighbours[projects.indexOf(test.info().project.name)]!
    await mapDrawn(page)
    await phoneTab(page, 'Pannello').click()
    await page.getByRole('searchbox', { name: 'Cerca un comune' }).fill(target)
    await page
      .getByRole('list', { name: 'Comuni trovati' })
      .getByRole('button', { name: target, exact: true })
      .click()

    // Its card: free, and it can be annexed from the capital next to it.
    await expect(page.getByRole('heading', { name: target })).toBeVisible()
    await expect(page.getByText('Comune libero').filter({ visible: true }).first()).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.getByRole('button', { name: 'Annetti' }).click()

    // Now it is Anna's, and its resources are shown to her.
    const visible = { visible: true }
    await expect(page.getByText(`Impero: ${world.anna.empire}`).filter(visible).first()).toBeVisible()
    await expect(page.getByText(/^Risorse: \d+/).filter(visible).first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('annexed.png'), fullPage: true })

    // The leaderboard counts it.
    await page.getByRole('button', { name: /^menu$/i }).click()
    await page.getByRole('button', { name: 'Classifica', exact: true }).click()
    await expect(page.getByRole('listitem').filter({ hasText: world.anna.empire })).toContainText(
      /[23] comuni/,
    )
  })

  test('selects a municipality with a tap on the map and shows it in a sheet', async ({ page }) => {
    await mapDrawn(page)
    // The map opens on the whole area: a tap in the middle lands on a municipality.
    const canvas = page.locator('canvas.maplibregl-canvas')
    await expect
      .poll(
        async () => {
          const box = (await canvas.boundingBox())!
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
          // The card of the municipality that was hit, whichever it is.
          return page.getByText(/^(Comune libero|Impero: )/).filter({ visible: true }).count()
        },
        { timeout: 30_000, intervals: [1000] },
      )
      .toBeGreaterThan(0)
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('tap.png') })
  })

  test('changes the view of the map and shows the tags of the empires', async ({ page }) => {
    await mapDrawn(page)
    const views = page.getByRole('group', { name: 'Vista della mappa' })
    await expect(views).toBeVisible()
    for (const view of ['Alleanze', 'Risorse', 'Politica']) {
      await views.getByRole('button', { name: view }).click()
      await expect(views.getByRole('button', { name: view })).toHaveAttribute('aria-pressed', 'true')
    }
    const tags = page.getByRole('button', { name: 'Sigle degli imperi' })
    await expect(tags).toHaveAttribute('aria-pressed', 'true')
    // The controls over the map do not cover each other.
    const [a, b] = [await views.boundingBox(), await tags.boundingBox()]
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1)
    await expectNoSidewaysScroll(page)
  })

  test('writes on the board from its own tab', async ({ page }) => {
    await mapDrawn(page)
    await phoneTab(page, 'Bacheca').click()
    const message = `Saluti dal telefono ${String(Date.now())}`
    await page.getByRole('textbox', { name: /Scrivi/ }).fill(message)
    await page.getByRole('button', { name: /^Invia|Pubblica/ }).click()
    await expect(page.getByText(message).filter({ visible: true }).first()).toBeVisible()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('board.png') })
  })

  test('reviews a past turn from the history and comes back', async ({ page }) => {
    await mapDrawn(page)
    await phoneTab(page, 'Pannello').click()
    await page.getByRole('button', { name: 'Storico dei turni', exact: true }).click()
    // The first turn is still being played: nothing is closed yet, and it says so.
    await expect(page.getByText('Nessun turno si è ancora chiuso.')).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})

test.describe('the other side, on a phone', () => {
  test('a guest sees the match and is invited to sign in, not to act', async ({ page }) => {
    await page.goto(matchUrl())
    await mapDrawn(page)
    await phoneTab(page, 'Pannello').click()
    await expect(page.getByRole('heading', { name: world.matchName })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Alleanze', exact: true })).toHaveCount(0)
    await expectNoSidewaysScroll(page)
  })

  test('the other player never sees the resources of an empire that is not theirs', async ({
    page,
    context,
  }) => {
    await playAs(context, 'bruno')
    await page.goto(matchUrl())
    await mapDrawn(page)
    await phoneTab(page, 'Pannello').click()
    await page.getByRole('searchbox', { name: 'Cerca un comune' }).fill(world.anna.capital)
    await page
      .getByRole('list', { name: 'Comuni trovati' })
      .getByRole('button', { name: world.anna.capital, exact: true })
      .click()
    await expect(
      page.getByText(`Impero: ${world.anna.empire}`).filter({ visible: true }).first(),
    ).toBeVisible()
    await expect(page.getByText(/^Risorse: \d+/)).toHaveCount(0)
    await expect(page.getByText('Risorse: nascoste').filter({ visible: true }).first()).toBeVisible()
  })
})
