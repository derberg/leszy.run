import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, cleanupClub, callFunction, createClub } from './helpers.js'

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

describe('upload-club-logo', () => {
  let owner, outsider, club
  before(async () => {
    owner = await createTestSession('logo-owner')
    outsider = await createTestSession('logo-out')
    club = await createClub(owner.sessionToken, 'Logo Test Club')
  })
  after(async () => {
    await cleanupClub(club.id)
    await cleanupUser(owner.user.id); await cleanupUser(outsider.user.id)
  })

  it('non-manager → 403', async () => {
    const { status } = await callFunction('upload-club-logo',
      { club_id: club.id, data_url: TINY_PNG_DATA_URL }, outsider.sessionToken)
    assert.equal(status, 403)
  })

  it('owner uploads a valid PNG → 200 with logo_url', async () => {
    const { status, data } = await callFunction('upload-club-logo',
      { club_id: club.id, data_url: TINY_PNG_DATA_URL }, owner.sessionToken)
    assert.equal(status, 200)
    assert.ok(data.data.logo_url.includes('club-logos'))
  })

  it('oversize payload (>5MB) → 400', async () => {
    const bigBytes = Buffer.alloc(6 * 1024 * 1024, 1)
    const bigDataUrl = `data:image/png;base64,${bigBytes.toString('base64')}`
    const { status } = await callFunction('upload-club-logo',
      { club_id: club.id, data_url: bigDataUrl }, owner.sessionToken)
    assert.equal(status, 400)
  })

  it('non-image mime (e.g. svg) → 400', async () => {
    const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}`
    const { status } = await callFunction('upload-club-logo',
      { club_id: club.id, data_url: svgDataUrl }, owner.sessionToken)
    assert.equal(status, 400)
  })
})
