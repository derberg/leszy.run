// The backend listens on port 3001 of the machine that serves this page, so the
// default is derived from the page's own hostname. A build that bakes one name in
// only works where that name resolves: checkpoint1's build used
// leszyrun-checkpoint1.local, and opened over Tailscale the panel loaded but every
// API call went to a name that does not resolve off the shared hotspot.
// VITE_API_URL / VITE_WS_URL still override when the backend lives elsewhere.
const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'

export const API_URL = import.meta.env.VITE_API_URL || `${secure ? 'https' : 'http'}://${host}:3001`
export const WS_URL = import.meta.env.VITE_WS_URL || `${secure ? 'wss' : 'ws'}://${host}:3001`
