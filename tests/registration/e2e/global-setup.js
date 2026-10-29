import { startCapture } from '../helpers/emailCaptureServer.js'
import { startDpayMock } from '../helpers/dpayMock.js'
import { resetThrottle } from '../helpers/stack.js'

export default async function globalSetup() {
  const stops = [await startCapture(), await startDpayMock()].filter(Boolean) // null when CI already started one
  await resetThrottle()
  return stops.length ? async () => { for (const stop of stops) await stop() } : undefined
}
