// Bare http(s) addresses in an organizer's plain text, as parts to render:
// { text } stays text, { href, text } becomes a link. Nothing else is parsed,
// so markup in the text is shown as typed, never rendered.
const URL_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING = /[.,;:!?)\]}]+$/

/** @param {string} text @returns {Array<{ text: string, href?: string }>} */
export function linkParts(text) {
  const out = []
  let last = 0
  for (const m of (text ?? '').matchAll(URL_RE)) {
    const href = m[0].replace(TRAILING, '')
    if (href.length <= 'https://'.length) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ href, text: href })
    last = m.index + href.length
  }
  if (last < (text ?? '').length) out.push({ text: text.slice(last) })
  return out.reduce((acc, p) => {
    const prev = acc.at(-1)
    if (!p.href && prev && !prev.href) prev.text += p.text
    else acc.push({ ...p })
    return acc
  }, [])
}
