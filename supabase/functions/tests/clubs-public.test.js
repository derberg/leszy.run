import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTestSession, cleanupUser, cleanupClub, callFunction, createClub, supabaseAdmin, FUNCTIONS_URL,
} from './helpers.js'

async function getClubPage(slug) {
  const res = await fetch(`${FUNCTIONS_URL}/render-club?slug=${encodeURIComponent(slug)}`)
  return { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() }
}

describe('render-club (public SSR)', () => {
  it('renders a public club page: 200, text/html, title, SportsTeam JSON-LD, indexable', async () => {
    const owner = await createTestSession('rc-owner1')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Klub Publiczny Render Test')

      const res = await getClubPage(club.slug)
      assert.equal(res.status, 200)
      assert.ok(res.contentType.includes('text/html'))
      assert.ok(res.body.includes(club.name))
      assert.match(res.body, /<title>/)
      assert.match(res.body, /"@type":"SportsTeam"/)
      assert.match(res.body, /name="robots" content="index,follow"/)
    } finally {
      await cleanupClub(club?.id)
      await cleanupUser(owner.user.id)
    }
  })

  it('404s (noindex) for a club with is_public=false', async () => {
    const owner = await createTestSession('rc-owner2')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Klub Prywatny Render Test')
      await supabaseAdmin.from('clubs').update({ is_public: false }).eq('id', club.id)

      const res = await getClubPage(club.slug)
      assert.equal(res.status, 404)
      assert.match(res.body, /noindex/)
    } finally {
      await cleanupClub(club?.id)
      await cleanupUser(owner.user.id)
    }
  })

  it('404s for an unknown slug', async () => {
    const res = await getClubPage('nie-ma-takiego-klubu-xyz-e2e')
    assert.equal(res.status, 404)
  })

  it('omits a hidden_public member entirely, and honors club_public_name=nickname once visible', async () => {
    const owner = await createTestSession('rc-owner3')
    const member = await createTestSession('rc-member3')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Klub Widoczność Render Test')
      await callFunction('request-join', { club_id: club.id }, member.sessionToken)
      await callFunction('respond-join',
        { club_id: club.id, user_id: member.user.id, action: 'approve' }, owner.sessionToken)

      await callFunction('update-profile', { display_name: 'Jan Kowalski Owner' }, owner.sessionToken)
      await callFunction('update-profile', {
        display_name: 'Marek Nowak Hidden',
        nickname: 'Szybki Marek',
        privacy_settings: { club_public_name: 'nickname' },
      }, member.sessionToken)
      await callFunction('manage-member',
        { club_id: club.id, action: 'set-visibility', hidden_public: true }, member.sessionToken)

      const hidden = await getClubPage(club.slug)
      assert.equal(hidden.status, 200)
      assert.ok(hidden.body.includes('Jan Kowalski Owner'))
      assert.ok(!hidden.body.includes('Marek Nowak Hidden'))
      assert.ok(!hidden.body.includes('Szybki Marek'), 'hidden_public member must not appear under any label')

      await callFunction('manage-member',
        { club_id: club.id, action: 'set-visibility', hidden_public: false }, member.sessionToken)

      const visible = await getClubPage(club.slug)
      assert.ok(visible.body.includes('Szybki Marek'), 'club_public_name=nickname should show the nickname')
      assert.ok(!visible.body.includes('Marek Nowak Hidden'), 'display_name must not leak when nickname is preferred')
    } finally {
      await cleanupClub(club?.id)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })
})
