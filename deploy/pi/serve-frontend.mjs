// Static server for the admin panel on the timing host (checkpoint1).
// Serves frontend/dist on 0.0.0.0:3000 with an SPA fallback to index.html.
// Run by leszyrun-frontend.service; rebuild the panel with scripts/update-pi.sh.
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'dist')
const PORT = 3000
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json',
}

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let fp = normalize(join(ROOT, p))
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end() }
    const s = await stat(fp).catch(() => null)
    if (s && s.isDirectory()) fp = join(fp, 'index.html')
    let buf = await readFile(fp).catch(() => null)
    if (!buf) { fp = join(ROOT, 'index.html'); buf = await readFile(fp) }
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(500)
    res.end('error')
  }
})

server.listen(PORT, '0.0.0.0', () => console.log('frontend static on 0.0.0.0:' + PORT))
