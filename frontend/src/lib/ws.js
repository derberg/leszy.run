import { useEffect, useRef, useCallback } from 'react'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001'

let socket = null
const listeners = new Map() // type → Set<callback>

function getSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return socket
  }

  socket = new WebSocket(WS_URL)

  socket.onmessage = (e) => {
    try {
      const { type, payload } = JSON.parse(e.data)
      const cbs = listeners.get(type)
      if (cbs) cbs.forEach(cb => cb(payload))
      // Also call '*' listeners
      const all = listeners.get('*')
      if (all) all.forEach(cb => cb({ type, payload }))
    } catch {}
  }

  socket.onclose = () => {
    setTimeout(() => getSocket(), 3000) // reconnect
  }

  return socket
}

export function subscribe(type, callback) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(callback)
  getSocket() // ensure connected

  return () => listeners.get(type)?.delete(callback)
}

// React hook
export function useWsEvent(type, callback) {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    const unsub = subscribe(type, (payload) => cbRef.current(payload))
    return unsub
  }, [type])
}

// Initiate connection eagerly on import
getSocket()
