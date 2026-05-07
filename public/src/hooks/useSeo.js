import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const SITE_NAME = 'Leszy.run'
const BASE_URL = 'https://www.leszy.run'
const DEFAULT_DESCRIPTION = 'Profesjonalna obsługa biegów i wydarzeń sportowych. Pomiar czasu RFID, zapisy online, wyniki na żywo. Kalendarz biegów w Polsce.'
const DEFAULT_IMAGE = `${BASE_URL}/og-image.png`

function setMeta(property, content, isOg = false) {
  const attr = isOg ? 'property' : 'name'
  let el = document.querySelector(`meta[${attr}="${property}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, property)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function setCanonical(url) {
  let el = document.querySelector('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', url)
}

function setJsonLd(id, data) {
  let el = document.getElementById(id)
  if (!el) {
    el = document.createElement('script')
    el.id = id
    el.type = 'application/ld+json'
    document.head.appendChild(el)
  }
  el.textContent = JSON.stringify(data)
}

function removeJsonLd(id) {
  const el = document.getElementById(id)
  if (el) el.remove()
}

/**
 * Hook to manage per-page SEO meta tags.
 *
 * @param {Object} options
 * @param {string} options.title - Page title (appended with site name)
 * @param {string} [options.description] - Meta description
 * @param {string} [options.path] - Canonical path (auto-detected from router if omitted)
 * @param {string} [options.image] - OG image URL
 * @param {string} [options.type] - OG type (default: 'website')
 * @param {Object} [options.jsonLd] - JSON-LD structured data object
 */
export default function useSeo({ title, description, path, image, type = 'website', jsonLd } = {}) {
  const location = useLocation()
  const canonicalPath = path || location.pathname

  useEffect(() => {
    const fullTitle = title ? `${title} — ${SITE_NAME}` : `${SITE_NAME} — Pomiar czasu i obsługa biegów`
    const desc = description || DEFAULT_DESCRIPTION
    const canonicalUrl = `${BASE_URL}${canonicalPath}`
    const ogImage = image || DEFAULT_IMAGE

    document.title = fullTitle

    // Standard meta
    setMeta('description', desc)
    setMeta('robots', 'index, follow')

    // Open Graph
    setMeta('og:title', fullTitle, true)
    setMeta('og:description', desc, true)
    setMeta('og:url', canonicalUrl, true)
    setMeta('og:image', ogImage, true)
    setMeta('og:type', type, true)
    setMeta('og:site_name', SITE_NAME, true)
    setMeta('og:locale', 'pl_PL', true)

    // Twitter Card
    setMeta('twitter:card', 'summary_large_image')
    setMeta('twitter:title', fullTitle)
    setMeta('twitter:description', desc)
    setMeta('twitter:image', ogImage)

    // Canonical
    setCanonical(canonicalUrl)

    // JSON-LD
    if (jsonLd) {
      setJsonLd('seo-page-jsonld', jsonLd)
    }

    return () => {
      removeJsonLd('seo-page-jsonld')
    }
  }, [title, description, canonicalPath, image, type, jsonLd])
}
