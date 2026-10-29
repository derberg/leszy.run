import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { initGa, sendPageView, trackedLocation, trackedPath } from '../../src/lib/trackedPath.js'

describe('trackedPath (what GA sees)', () => {
  it('a magic login link never sends the address or the code', () => {
    assert.equal(trackedPath('/login', '?email=ola%40x.pl&code=123456&from=%2Fprofil'), '/login?from=%2Fprofil')
    assert.equal(trackedPath('/login', '?email=ola%40x.pl&code=123456'), '/login')
  })

  it('the searched bib stays out, other parameters stay in', () => {
    assert.equal(trackedPath('/events/x/results', '?nr=12&kategoria=k'), '/events/x/results?kategoria=k')
    assert.equal(trackedPath('/kalendarz', ''), '/kalendarz')
  })

  it('check-in and volunteer credentials stay out: p, t, pin', () => {
    assert.equal(trackedPath('/events/x/checkin', '?p=id&t=token'), '/events/x/checkin')
    assert.equal(trackedPath('/events/x/volunteer', '?checkpoint=cp&pin=1234567890'), '/events/x/volunteer?checkpoint=cp')
    assert.equal(
      trackedPath('/x', '?p=abc&t=tok&pin=123&email=a%40b.pl&code=1&nr=12&from=x'),
      '/x?from=x',
    )
  })

  it('trackedLocation drops them from page_location too', () => {
    assert.equal(
      trackedLocation({ origin: 'https://www.leszy.run', pathname: '/events/x/checkin', search: '?p=id&t=token' }),
      'https://www.leszy.run/events/x/checkin',
    )
  })
})

describe('GA setup: every hit carries the cleaned page_location (final review M6)', () => {
  const loc = { origin: 'https://www.leszy.run', pathname: '/login', search: '?email=ola%40x.pl&code=123456&from=%2Fp' }
  const recorder = () => {
    const calls = []
    return { calls, gtag: (...args) => calls.push(args) }
  }

  it('trackedLocation is the origin plus the tracked path', () => {
    assert.equal(trackedLocation(loc), 'https://www.leszy.run/login?from=%2Fp')
  })

  it('initGa sets the cleaned page_location before config, so automatic events never see the raw address', () => {
    const { calls, gtag } = recorder()
    initGa(gtag, 'G-X', loc)
    const set = calls.findIndex((c) => c[0] === 'set')
    const config = calls.findIndex((c) => c[0] === 'config')
    assert.ok(set >= 0 && set < config, JSON.stringify(calls))
    assert.deepEqual(calls[set], ['set', { page_location: 'https://www.leszy.run/login?from=%2Fp' }])
    assert.deepEqual(calls[config], ['config', 'G-X', { send_page_view: false, page_location: 'https://www.leszy.run/login?from=%2Fp' }])
    assert.ok(!JSON.stringify(calls).includes('ola'), 'no address anywhere')
  })

  it('sendPageView updates the global page_location, then sends the page view', () => {
    const { calls, gtag } = recorder()
    sendPageView(gtag, loc, 'Logowanie')
    assert.deepEqual(calls, [
      ['set', { page_location: 'https://www.leszy.run/login?from=%2Fp' }],
      ['event', 'page_view', { page_path: '/login?from=%2Fp', page_location: 'https://www.leszy.run/login?from=%2Fp', page_title: 'Logowanie' }],
    ])
  })
})
