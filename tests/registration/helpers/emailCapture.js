import { CAPTURE_PORT, startCapture } from './emailCaptureServer.js'

export { startCapture }
const base = `http://127.0.0.1:${CAPTURE_PORT}`

export async function messagesTo(email) {
  const res = await fetch(`${base}/messages?to=${encodeURIComponent(email)}`)
  return (await res.json()).data
}

/** The 6-digit login code from the newest message to `email` (subject starts with it). */
export async function lastCodeFor(email) {
  const msgs = await messagesTo(email)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = (msgs[i].subject || '').match(/^(\d{6})\b/) || (msgs[i].text || '').match(/\b(\d{6})\b/)
    if (m) return m[1]
  }
  return null
}

export async function clearMessages() {
  await fetch(`${base}/messages`, { method: 'DELETE' })
}
export { clearMessages as reset }
