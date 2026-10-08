import { expect, type BrowserContext, type Page } from '@playwright/test'

import { BASE_URL, readWorld, type World } from './world'

export const world: World = readWorld()

/** Makes the browser a player of the match: the session cookie, as after a login. */
export async function playAs(context: BrowserContext, who: 'anna' | 'bruno'): Promise<void> {
  await context.addCookies([
    { name: 'sid', value: world[who].token, url: BASE_URL, httpOnly: true, sameSite: 'Lax' },
  ])
}

export const matchUrl = () => `/match/${world.matchId}`

/** The three views of a match on a phone, at the bottom of the screen. */
export const phoneTab = (page: Page, name: 'Mappa' | 'Pannello' | 'Bacheca') =>
  page.getByRole('tab', { name, exact: true })

/**
 * Nothing sticks out of the screen sideways: the page never scrolls
 * horizontally on a phone, whatever is shown.
 */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    return root.scrollWidth - window.innerWidth
  })
  expect(overflow, 'the page is wider than the screen').toBeLessThanOrEqual(0)
}

/** Whatever can be tapped among these is at least as tall as a fingertip needs. */
export async function expectTappable(page: Page, names: (string | RegExp)[]): Promise<void> {
  for (const name of names) {
    const target = page.getByRole('button', { name }).or(page.getByRole('tab', { name })).first()
    const box = await target.boundingBox()
    expect(box, `"${String(name)}" is not on the page`).not.toBeNull()
    expect(box?.height ?? 0, `"${String(name)}" is too small to tap`).toBeGreaterThanOrEqual(36)
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= page.viewportSize()!.width + 1).toBe(true)
  }
}

/** Waits until the map has drawn itself at least once. */
export async function mapDrawn(page: Page): Promise<void> {
  const canvas = page.locator('canvas.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas')
    return element !== null && element.width > 0 && element.height > 0
  })
}
