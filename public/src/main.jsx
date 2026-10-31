import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './app.css'
import { installStaleChunkReload } from './lib/staleChunkReload.js'
import { captureConsentToken } from './lib/consentToken.js'

installStaleChunkReload(window, window.sessionStorage)
// /zgoda#<token>: the token leaves the address bar before anything renders or loads.
captureConsentToken(window)
// A consent link opened in a tab already on /zgoda changes only the fragment (no page load): load
// the page again so the capture above runs for the new link.
window.addEventListener('hashchange', () => {
  if (window.location.pathname === '/zgoda' && window.location.hash.length > 1) window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
