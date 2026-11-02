// „Pochwal się” on RA5: the event page's address, never anything about the
// person who registered. The link carries `?z=1`, which makes its preview the
// „JESTEM NA LIŚCIE STARTOWEJ” card (api/event-page.js). Facebook takes only the
// address (it ignores any text given to it); WhatsApp gets the text and the
// address, and builds the same card under it.

/** The address a runner shares for one event. */
export function signedUpShareUrl(slug) {
  return `https://www.leszy.run/events/${slug}?z=1`
}

/** „Jestem na liście startowej: <name> (<date>)! Zapisz się też 👉” */
export function signedUpShareText(title, date) {
  return `Jestem na liście startowej: ${title}${date ? ` (${date})` : ''}! Zapisz się też 👉`
}

/** @param {{ url: string, text: string }} p */
export function shareLinks({ url, text }) {
  return [
    { id: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}` },
  ]
}

/** The 1080x1920 story image of the same card, for Instagram. */
export function storyImagePath(slug) {
  return `/api/event-og?slug=${slug}&v=story`
}
