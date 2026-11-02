// Opens the browser's print dialog for the page's [data-print-doc] element,
// where "Zapisz jako PDF" saves it. The element is copied into a container of
// its own and everything else is hidden while printing (app.css, PRINT), so the
// copy flows across pages. The browser names the PDF after document.title, so
// the title is swapped for the print and put back after.
export function printDocument(title) {
  const doc = document.querySelector('[data-print-doc]')
  if (!doc) return
  const root = document.createElement('div')
  root.id = 'print-root'
  root.appendChild(doc.cloneNode(true))
  document.body.appendChild(root)
  const previous = document.title
  document.title = title
  const restore = () => {
    window.removeEventListener('afterprint', restore)
    document.title = previous
    root.remove()
  }
  window.addEventListener('afterprint', restore)
  window.print()
}
