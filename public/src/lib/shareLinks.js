// „Udostępnij” on RA5: the event page's address, never anything about the
// person who registered. A phone opens its own share sheet (navigator.share);
// elsewhere these links open each network's share dialog.

/** @param {{ url: string, text: string }} p */
export function shareLinks({ url, text }) {
  const u = encodeURIComponent(url)
  return [
    { id: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { id: 'x', label: 'X', href: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${u}` },
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}` },
  ]
}
