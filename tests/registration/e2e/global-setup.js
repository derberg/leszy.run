import { startCapture } from '../helpers/emailCaptureServer.js'
import { resetThrottle } from '../helpers/stack.js'

export default async function globalSetup() {
  const stop = await startCapture() // null when CI already started it
  await resetThrottle()
  return stop || undefined
}
