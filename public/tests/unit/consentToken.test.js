// G-48 (Plan 4 task 6): the consent page takes the token out of the address bar before anything
// is fetched. The link is ${PUBLIC_SITE_URL}/zgoda#<token>; the fragment never reaches a server,
// and once dropped it reaches no referrer, history entry or analytics hit either.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { captureConsentToken, consentToken, forgetConsentToken, resetConsentTokenForTests } from '../../src/lib/consentToken.js'

const TOKEN = 'Zx9_abcDEFghiJKLmnoPQRstuVWXyz0123456789-_A'

function fakeWindow({ pathname = '/zgoda', search = '', hash = `#${TOKEN}`, storage = new Map(), log = [] } = {}) {
  const win = {
    log,
    location: { pathname, search, hash },
    history: {
      state: { idx: 3 },
      replaceState(state, _title, url) {
        log.push(['replaceState', state, url])
        const u = new URL(url, 'https://www.leszy.run')
        win.location.pathname = u.pathname
        win.location.search = u.search
        win.location.hash = u.hash
      },
    },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { log.push(['setItem', k]); storage.set(k, v) },
      removeItem: (k) => storage.delete(k),
    },
    fetch: (url) => { log.push(['fetch', url, win.location.hash]); return Promise.resolve() },
  }
  return win
}

describe('G-48 captureConsentToken', () => {
  it('reads the fragment and drops it with replaceState, keeping the router state, before any fetch', () => {
    resetConsentTokenForTests()
    const win = fakeWindow()
    assert.equal(captureConsentToken(win), TOKEN)
    assert.equal(win.location.hash, '')
    const replace = win.log.find((e) => e[0] === 'replaceState')
    assert.deepEqual(replace, ['replaceState', { idx: 3 }, '/zgoda'])
    // Whatever runs next (the page's first consent-request, GA, a font) sees no fragment.
    win.fetch('https://www.googletagmanager.com/gtag/js')
    assert.deepEqual(win.log.at(-1), ['fetch', 'https://www.googletagmanager.com/gtag/js', ''])
  })

  it('keeps the query string and leaves other pages alone', () => {
    resetConsentTokenForTests()
    const win = fakeWindow({ search: '?utm_source=mail' })
    assert.equal(captureConsentToken(win), TOKEN)
    assert.equal(win.log.find((e) => e[0] === 'replaceState')[2], '/zgoda?utm_source=mail')

    resetConsentTokenForTests()
    const other = fakeWindow({ pathname: '/events/x', hash: '#trasa' })
    assert.equal(captureConsentToken(other), null)
    assert.equal(other.location.hash, '#trasa', 'an anchor elsewhere is untouched')
  })

  it('a malformed fragment is dropped too, and yields no token', () => {
    resetConsentTokenForTests()
    const win = fakeWindow({ hash: '#not a token' })
    assert.equal(captureConsentToken(win), null)
    assert.equal(win.location.hash, '')
  })

  it('a second call (React strict mode, the page mounting after main.jsx) returns the same token', () => {
    resetConsentTokenForTests()
    const win = fakeWindow()
    captureConsentToken(win)
    assert.equal(consentToken(win), TOKEN)
    assert.equal(win.log.filter((e) => e[0] === 'replaceState').length, 1)
  })

  it('survives a reload of the tab (sessionStorage), and forgetConsentToken ends it', () => {
    resetConsentTokenForTests()
    const storage = new Map()
    captureConsentToken(fakeWindow({ storage }))
    resetConsentTokenForTests() // a reload: module state gone, the tab's storage kept
    const reloaded = fakeWindow({ storage, hash: '' })
    assert.equal(consentToken(reloaded), TOKEN)
    forgetConsentToken(reloaded)
    resetConsentTokenForTests()
    assert.equal(consentToken(fakeWindow({ storage, hash: '' })), null)
  })

  it('storage that throws (private mode) still gives the token from the fragment', () => {
    resetConsentTokenForTests()
    const win = fakeWindow()
    win.sessionStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
    assert.equal(captureConsentToken(win), TOKEN)
    assert.equal(consentToken(win), TOKEN)
  })
})
