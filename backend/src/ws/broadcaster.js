import { WebSocketServer } from 'ws'

let wss = null
const clients = new Set()

export function initWebSocket(server) {
  wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  console.log('[WS] WebSocket server ready')
}

export function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload })
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg)
    }
  }
}
