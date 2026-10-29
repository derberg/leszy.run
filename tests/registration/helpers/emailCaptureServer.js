// Standalone email capture for the local test stack. The edge functions POST
// every outgoing email here (EMAIL_CAPTURE_URL) instead of SendGrid.
//   POST /send         store { to, subject, text, html, replyTo, fromName }; `to`
//                      may be a list (one batched request): stored once per
//                      address, each carrying the request's `batch` number
//   GET /messages?to=  list (optionally for one recipient)
//   GET /requests      one entry per POST: { batch, recipients, subject }
//   DELETE /messages   clear both
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const CAPTURE_PORT = 54399

function listening(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/messages', timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** Starts the server in this process. Resolves to a stop function, or null when one already listens. */
export async function startCapture(port = CAPTURE_PORT) {
  if (await listening(port)) return null
  const messages = []
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try {
          const m = JSON.parse(raw)
          const batch = requests.length + 1
          const to = Array.isArray(m.to) ? m.to : [m.to]
          requests.push({ batch, recipients: to.length, subject: m.subject })
          const receivedAt = new Date().toISOString()
          for (const address of to) messages.push({ ...m, to: address, batch, receivedAt })
          send(200, { ok: true })
        } catch { send(400, { error: 'bad json' }) }
      })
    } else if (req.method === 'GET' && url.pathname === '/messages') {
      const to = url.searchParams.get('to')
      send(200, { data: to ? messages.filter((m) => m.to?.toLowerCase() === to.toLowerCase()) : messages })
    } else if (req.method === 'GET' && url.pathname === '/requests') {
      send(200, { data: requests })
    } else if (req.method === 'DELETE' && url.pathname === '/messages') {
      messages.length = 0
      requests.length = 0
      send(200, { ok: true })
    } else send(404, { error: 'not found' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })
  return () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = await startCapture()
  if (stop) console.log(`email capture listening on :${CAPTURE_PORT}`)
  else console.log('email capture already running')
}
