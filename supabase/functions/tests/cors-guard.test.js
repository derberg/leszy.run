import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { guardRequest, getCorsHeaders } from '../_shared/cors.js'

// Pure — runs locally, no deployed function involved.

const url = 'https://project.supabase.co/functions/v1/delete-club'
const post = (origin) => new Request(url, {
  method: 'POST',
  headers: origin ? { Origin: origin } : {},
  body: '{}',
})

describe('guardRequest', () => {
  it('answers a preflight instead of running the function', async () => {
    const res = guardRequest(new Request(url, { method: 'OPTIONS', headers: { Origin: 'https://www.leszy.run' } }))
    assert.ok(res instanceof Response)
    assert.equal(res.status, 200)
  })

  it('lets a request from the app through', () => {
    assert.equal(guardRequest(post('https://www.leszy.run')), null)
    assert.equal(guardRequest(post('https://leszy.run')), null)
    assert.equal(guardRequest(post('https://leszy-run-abc123-derbergs-projects.vercel.app')), null)
  })

  it('lets every local dev server through, whatever port the README told you to use', () => {
    // scripts/dev.sh runs the public app on 3002, package.json on 5173,
    // vite preview on 4173. Allowing only one of them breaks the documented
    // setup for everyone else.
    for (const origin of [
      'http://localhost:5173', 'http://localhost:3002', 'http://localhost:4173',
      'http://127.0.0.1:5173', 'http://127.0.0.1:3002',
    ]) {
      assert.equal(guardRequest(post(origin)), null, `${origin} should be allowed`)
    }
  })

  it('lets a request with no Origin through — that is a server, not a browser', () => {
    assert.equal(guardRequest(post(null)), null)
  })

  it('refuses a request a foreign page made with our cookie', () => {
    const res = guardRequest(post('https://evil.example'))
    assert.ok(res instanceof Response)
    assert.equal(res.status, 403)
  })

  it('refuses a look-alike origin', () => {
    for (const origin of [
      'https://www.leszy.run.evil.example',
      'https://evil.leszy.run',
      'http://www.leszy.run',
      'https://leszy-run-abc.evil-derbergs-projects.vercel.app',
      'http://localhost.evil.example',
      'https://localhost:5173',
    ]) {
      const res = guardRequest(post(origin))
      assert.ok(res instanceof Response, `${origin} should be refused`)
      assert.equal(res.status, 403, `${origin} should be refused`)
    }
  })

  it('still answers a refused request with CORS headers so the browser reports the status', () => {
    const res = guardRequest(post('https://evil.example'))
    assert.ok(res.headers.get('Access-Control-Allow-Origin'))
  })
})

describe('getCorsHeaders', () => {
  it('never reflects an origin it does not know', () => {
    const headers = getCorsHeaders(post('https://evil.example'))
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://www.leszy.run')
  })
})
