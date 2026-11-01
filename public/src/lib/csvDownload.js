// Hands a CSV the server wrote to the browser as a file. The text already starts with the UTF-8
// BOM Polish Excel needs (entriesCsv.js), so it is saved as is, never re-encoded.

/**
 * @param {string} filename
 * @param {string} csv
 * @param {{ document?: Document, URL?: typeof URL }} [env] for tests
 */
export function downloadCsv(filename, csv, env = {}) {
  const doc = env.document ?? document
  const urls = env.URL ?? URL
  const href = urls.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = doc.createElement('a')
  link.href = href
  link.download = filename
  link.style.display = 'none'
  doc.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // After the click has handed the blob to the download; revoking at once can cancel it in Safari.
    setTimeout(() => urls.revokeObjectURL(href), 1000)
  }
}
