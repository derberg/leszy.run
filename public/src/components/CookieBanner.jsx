import { useState, useEffect } from 'react'

const GA_ID = 'G-8JRNXVX5Z9'
const CONSENT_KEY = 'leszy-cookie-consent'

function loadGA() {
  if (document.getElementById('ga-script')) return
  const script = document.createElement('script')
  script.id = 'ga-script'
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`
  document.head.appendChild(script)
  window.dataLayer = window.dataLayer || []
  function gtag() { window.dataLayer.push(arguments) }
  gtag('js', new Date())
  gtag('config', GA_ID)
}

function removeGA() {
  const script = document.getElementById('ga-script')
  if (script) script.remove()
  window.dataLayer = undefined
  // Remove GA cookies
  document.cookie.split(';').forEach(c => {
    const name = c.trim().split('=')[0]
    if (name.startsWith('_ga') || name.startsWith('_gid')) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.${location.hostname}`
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
    }
  })
}

export default function CookieBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const consent = localStorage.getItem(CONSENT_KEY)
    if (consent === 'accepted') {
      loadGA()
    } else if (consent === null) {
      setVisible(true)
    }
    // If 'rejected', do nothing — no GA, no banner
  }, [])

  function accept() {
    localStorage.setItem(CONSENT_KEY, 'accepted')
    loadGA()
    setVisible(false)
  }

  function reject() {
    localStorage.setItem(CONSENT_KEY, 'rejected')
    removeGA()
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-apex-border bg-apex-surface p-4">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <p className="text-sm text-apex-text">
          Używamy plików cookie (Google Analytics) aby analizować ruch na stronie.{' '}
          Możesz zaakceptować lub odrzucić.
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
