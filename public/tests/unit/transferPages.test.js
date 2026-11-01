// Plan 7 task 8b: the runner's transfer pages (RA5 action, RA6 /events/:slug/przekaz/:id, RA7
// /przekazanie#<token>). V-64: the token lives in the fragment only, is dropped before any request
// and never reaches GA. Every refusal the transfer functions can give has a Polish line on the page.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { captureTransferToken, forgetTransferToken, resetTransferTokenForTests, transferToken } from '../../src/lib/transferToken.js'
import { captureConsentToken, resetConsentTokenForTests } from '../../src/lib/consentToken.js'
import { sendPageView } from '../../src/lib/trackedPath.js'
import {
  TRANSFER_MESSAGES, inviteError, acceptError, transferAction, untilLabel, samePriceLabel, closedBadge,
} from '../../src/lib/transferCopy.js'
import { TRANSFER_REFUSALS } from '../../../supabase/functions/_shared/registration/transfers.js'

const TOKEN = 'Zx9_abcDEFghiJKLmnoPQRstuVWXyz0123456789-_A'

function fakeWindow({ pathname = '/przekazanie', search = '', hash = `#${TOKEN}`, storage = new Map(), log = [] } = {}) {
  const win = {
    log,
    location: { pathname, search, hash },
    history: {
      state: { idx: 1 },
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
  }
  return win
}

describe('V-64 the transfer link: the token is taken from the fragment and GA never sees it', () => {
  it('captureTransferToken reads #<token> on /przekazanie and drops it with replaceState, keeping state and query', () => {
    resetTransferTokenForTests()
    const win = fakeWindow({ search: '?utm_source=mail' })
    assert.equal(captureTransferToken(win), TOKEN)
    assert.equal(win.location.hash, '')
    assert.deepEqual(win.log.find((e) => e[0] === 'replaceState'), ['replaceState', { idx: 1 }, '/przekazanie?utm_source=mail'])
  })

  it('a malformed fragment is dropped and gives no token; another page, and the consent page, are left alone', () => {
    resetTransferTokenForTests()
    const bad = fakeWindow({ hash: '#nie-token' })
    assert.equal(captureTransferToken(bad), null)
    assert.equal(bad.location.hash, '')

    resetTransferTokenForTests()
    const other = fakeWindow({ pathname: '/events/x', hash: '#trasa' })
    assert.equal(captureTransferToken(other), null)
    assert.equal(other.location.hash, '#trasa')

    resetTransferTokenForTests()
    const consent = fakeWindow({ pathname: '/zgoda' })
    assert.equal(captureTransferToken(consent), null)
    assert.equal(consent.location.hash, `#${TOKEN}`, 'the consent page keeps its own fragment for its own capture')
  })

  it('the two links keep separate tokens in separate storage keys', () => {
    resetTransferTokenForTests()
    resetConsentTokenForTests()
    const storage = new Map()
    captureTransferToken(fakeWindow({ storage }))
    captureConsentToken(fakeWindow({ pathname: '/zgoda', storage, hash: `#${'B'.repeat(43)}` }))
    resetTransferTokenForTests()
    assert.equal(transferToken(fakeWindow({ storage, hash: '' })), TOKEN)
    forgetTransferToken(fakeWindow({ storage, hash: '' }))
    resetTransferTokenForTests()
    assert.equal(transferToken(fakeWindow({ storage, hash: '' })), null)
    assert.equal([...storage.values()].includes('B'.repeat(43)), true, 'the consent token is untouched')
  })

  it('a second capture (strict mode) returns the same token with one replaceState; throwing storage still works', () => {
    resetTransferTokenForTests()
    const win = fakeWindow()
    captureTransferToken(win)
    assert.equal(transferToken(win), TOKEN)
    assert.equal(win.log.filter((e) => e[0] === 'replaceState').length, 1)

    resetTransferTokenForTests()
    const priv = fakeWindow()
    priv.sessionStorage = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
    assert.equal(captureTransferToken(priv), TOKEN)
  })

  it('sendPageView for /przekazanie#<token> sends page_path /przekazanie and no token anywhere', () => {
    const calls = []
    sendPageView((...a) => calls.push(a), { origin: 'https://www.leszy.run', pathname: '/przekazanie', search: '', hash: `#${TOKEN}` }, 'Przekazanie')
    const view = calls.find((c) => c[0] === 'event')[2]
    assert.equal(view.page_path, '/przekazanie')
    assert.equal(view.page_location, 'https://www.leszy.run/przekazanie')
    assert.ok(!JSON.stringify(calls).includes(TOKEN))
    assert.ok(!JSON.stringify(calls).includes('#'))
  })
})

const POLISH = /[a-ząćęłńóśźż]/i
const ENGLISH = /^(Not found|Internal server error|Authorization required|Invalid JSON|Too many requests)$/

describe('the transfer pages answer every refusal in Polish', () => {
  it('every code the transfer functions know has its own Polish line, and none is the English 404 text', () => {
    const codes = [...Object.keys(TRANSFER_REFUSALS), 'throttled', 'expired', 'not_pending', 'code_required', 'email_retired', 'invalid_action']
    for (const code of codes) {
      const msg = TRANSFER_MESSAGES[code]
      assert.ok(msg, `no copy for ${code}`)
      assert.ok(POLISH.test(msg) && !ENGLISH.test(msg), `${code}: ${msg}`)
    }
    assert.equal(TRANSFER_MESSAGES.gone, 'Ten link został już użyty, cofnięty albo wygasł.')
    assert.equal(TRANSFER_MESSAGES.transfer_off, 'Przekazanie pakietu nie jest już możliwe.')
    assert.equal(TRANSFER_MESSAGES.pending_exists, 'Zaproszenie już wysłane. Cofnij je, aby wysłać nowe.')
    assert.equal(TRANSFER_MESSAGES.recipient_minor, 'Pakiet może przejąć tylko osoba pełnoletnia.')
  })

  it('inviteError and acceptError never hand an English server text to the page', () => {
    const answers = [
      { status: 404, code: undefined, message: 'Not found' },
      { status: 404, code: 'not_owner', message: 'Not found' },
      { status: 500, message: 'Internal server error' },
      { status: 401, message: 'Authorization required' },
      { status: 400, message: 'Invalid JSON' },
      { status: 429, message: 'Too many requests' },
      { status: undefined, message: 'Failed to fetch' },
      { status: 418, code: 'something_new', message: 'teapot' },
    ]
    for (const err of answers) {
      for (const fn of [inviteError, acceptError]) {
        const msg = fn(err)
        assert.ok(POLISH.test(msg) && !ENGLISH.test(msg) && msg !== 'teapot' && msg !== 'Failed to fetch', `${fn.name}(${JSON.stringify(err)}) → ${msg}`)
      }
    }
    // The code's own Polish text from the server (verifyCode) is kept: it says what went wrong.
    assert.equal(acceptError({ status: 401, message: 'Nieprawidłowy kod.' }), 'Nieprawidłowy kod.')
    assert.equal(acceptError({ status: 409, code: 'gone', message: 'x' }), TRANSFER_MESSAGES.gone)
  })
})

describe('V-65 RA5: the transfer action follows the server', () => {
  it('shown only when the row says allowed; a pending invite names its address', () => {
    assert.deepEqual(transferAction({ id: 'r1', transfer: { allowed: true, until: '2026-11-20', pending: null } }, 'bieg'),
      { href: '/events/bieg/przekaz/r1', label: 'Przekaż pakiet innej osobie →', pending: null })
    assert.equal(transferAction({ id: 'r2', role: 'minor', transfer: { allowed: false, until: '2026-11-20', pending: null } }, 'bieg'), null)
    assert.equal(transferAction({ id: 'r3', transfer: { allowed: false, until: null, pending: null } }, 'bieg'), null)
    assert.equal(transferAction({ id: 'r4' }, 'bieg'), null, 'an older server with no transfer block')
    assert.equal(transferAction({ id: 'r5', transfer: { allowed: true, until: '2026-11-20', pending: { toEmail: 'jan@x.pl' } } }, 'bieg').pending, 'Czeka na jan@x.pl')
  })

  it('RA6 and RA7 labels', () => {
    assert.equal(untilLabel('2026-11-05'), 'MOŻLIWE DO 5.11 · BEZ OPŁATY')
    assert.equal(samePriceLabel('60,00 zł'), 'Konkurencja · w tej samej cenie (60 zł)')
    assert.equal(samePriceLabel('42,50 zł'), 'Konkurencja · w tej samej cenie (42,50 zł)')
    assert.equal(closedBadge({ registrationClosed: true, priceLabel: '60,00 zł' }), 'PAKIET OPŁACONY · ZAPISY ZAMKNIĘTE, ALE TEN LINK DZIAŁA')
    assert.equal(closedBadge({ registrationClosed: true, priceLabel: '0,00 zł' }), 'ZAPISY ZAMKNIĘTE, ALE TEN LINK DZIAŁA')
    assert.equal(closedBadge({ registrationClosed: false, priceLabel: '60,00 zł' }), null)
  })
})
