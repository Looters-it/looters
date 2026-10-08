import { BASE_URL, createWorld } from './world'

export default async function globalSetup(): Promise<void> {
  const ready = await fetch(`${BASE_URL}/api/health/ready`).catch(() => null)
  if (!ready?.ok) {
    throw new Error(`the stack is not answering at ${BASE_URL}: run "docker compose up -d" first`)
  }
  const world = await createWorld()
  console.log(`e2e match ${world.matchId}: ${world.anna.capital} and ${world.bruno.capital}`)
}
