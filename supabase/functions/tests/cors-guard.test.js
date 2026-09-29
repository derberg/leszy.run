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
    assert.equal(guardRequest(post('http://localhost:5173')), null)
    assert.equal(guardRequest(post('https://leszy-run-abc123-derbergs-projects.vercel.app')), null)
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
