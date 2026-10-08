import { removeWorld } from './world'

/** The match and the users of the tests go; the municipalities stay for the next run. */
export default async function globalTeardown(): Promise<void> {
  if (!process.env.E2E_KEEP) await removeWorld()
}
