import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './app.css'
import { installStaleChunkReload } from './lib/staleChunkReload.js'
import { captureConsentToken } from './lib/consentToken.js'
import { captureTransferToken, TRANSFER_PATH } from './lib/transferToken.js'

installStaleChunkReload(window, window.sessionStorage)
// /zgoda#<token> and /przekazanie#<token>: the token leaves the address bar before anything
// renders or loads.
captureConsentToken(window)
captureTransferToken(window)
// A link opened in a tab already on its page changes only the fragment (no page load): load the
// page again so the capture above runs for the new link.
window.addEventListener('hashchange', () => {
  const { pathname, hash } = window.location
  if ((pathname === '/zgoda' || pathname === TRANSFER_PATH) && hash.length > 1) window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
