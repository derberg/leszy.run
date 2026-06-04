import { useState, useEffect, useCallback } from 'react'
import { POLICY_VERSION } from '../lib/policyVersion'
import { logConsentServerSide } from '../lib/logConsent'

const GA_ID = 'G-8JRNXVX5Z9'
const CONSENT_KEY = 'leszy-cookie-consent'
const IS_DEV = import.meta.env.DEV

function loadGA() {
  if (IS_DEV) {
    console.log('[DEV] Google Analytics disabled in development mode')
    return
  }
  if (document.getElementById('ga-script')) return
  const script = document.createElement('script')
  script.id = 'ga-script'
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`
  document.head.appendChild(script)
  window.dataLayer = window.dataLayer || []
  function gtag() { window.dataLayer.push(arguments) }
  window.gtag = gtag
  gtag('js', new Date())
  gtag('config', GA_ID, { send_page_view: false })
}

function removeGA() {
  const script = document.getElementById('ga-script')
  if (script) script.remove()
  window.dataLayer = undefined
  document.cookie.split(';').forEach(c => {
    const name = c.trim().split('=')[0]
    if (name.startsWith('_ga') || name.startsWith('_gid')) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.${location.hostname}`
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
    }
  })
}

function readConsent() {
  const raw = localStorage.getItem(CONSENT_KEY)
  if (!raw) return null
  // Backwards-compat: legacy string format
  if (raw === 'accepted' || raw === 'rejected') {
    return { decision: raw, timestamp: null, policyVersion: 'pre-2026-06-04', userAgent: null }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeConsent(decision) {
  const record = {
    decision,
    timestamp: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    userAgent: navigator.userAgent,
  }
  localStorage.setItem(CONSENT_KEY, JSON.stringify(record))
  return record
}


export default function CookieBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const consent = readConsent()
    if (!consent) {
      setVisible(true)
      return
    }
    if (consent.policyVersion !== POLICY_VERSION) {
      setVisible(true)
      return
    }
    if (consent.decision === 'accepted') loadGA()
  }, [])

  const openManually = useCallback(() => {
    setVisible(true)
  }, [])

  useEffect(() => {
    window.addEventListener('leszy:cookies:open', openManually)
    return () => window.removeEventListener('leszy:cookies:open', openManually)
  }, [openManually])

  function accept() {
    const record = writeConsent('accepted')
    loadGA()
    setVisible(false)
    logConsentServerSide(record.decision)
  }

  function reject() {
    const record = writeConsent('rejected')
    removeGA()
    setVisible(false)
    logConsentServerSide(record.decision)
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-apex-border bg-apex-surface p-4">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <p className="text-sm text-apex-text">
          Używamy plików cookie do analizy ruchu (Google Analytics). Wyrażenie zgody jest opcjonalne. Szczegóły w <a href="/polityka-prywatnosci" className="text-apex-yellow underline">polityce prywatności</a>.
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={reject}
            className="border border-apex-border px-4 py-1.5 text-sm font-semibold text-apex-text hover:border-apex-yellow hover:text-apex-yellow"
          >
            Odrzuć
          </button>
          <button
            onClick={accept}
            className="border border-apex-yellow bg-apex-yellow px-4 py-1.5 text-sm font-semibold text-apex-ink hover:bg-apex-yellow-bright"
          >
            Akceptuję
          </button>
        </div>
      </div>
    </div>
  )
}
