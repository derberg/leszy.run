import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { processPartnerLogo, PartnerLogoError } from '../src/lib/partnerLogo.js'

const rejects = (buf, msg) =>
  assert.rejects(processPartnerLogo(buf), (e) => e instanceof PartnerLogoError && e.status === 400 && e.message === msg)

test('partner logo: SVG is refused', async () => {
  await rejects(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), 'Dozwolone: PNG, JPG, WebP.')
})

test('partner logo: garbage is refused', async () => {
  await rejects(Buffer.from('not an image'), 'Dozwolone: PNG, JPG, WebP.')
})

test('partner logo: forged 7000x10 PNG header is refused', async () => {
  const real = await sharp({ create: { width: 7000, height: 10, channels: 3, background: '#fff' } }).png().toBuffer()
  await rejects(real, 'Obraz jest za duży (maks. 6000×6000 px).')
})

test('partner logo: over 2 MB is refused', async () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2 * 1024 * 1024)])
  await rejects(big, 'Plik jest za duży (limit 2 MB).')
})

test('partner logo: 900x900 JPEG becomes a 400x400 PNG', async () => {
  const jpg = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#c33' } }).jpeg().toBuffer()
  const { png } = await processPartnerLogo(jpg)
  const m = await sharp(png).metadata()
  assert.equal(m.format, 'png')
  assert.equal(m.width, 400)
  assert.equal(m.height, 400)
})

test('partner logo: a small PNG is not enlarged', async () => {
  const src = await sharp({ create: { width: 50, height: 20, channels: 4, background: '#0f0' } }).png().toBuffer()
  const m = await sharp((await processPartnerLogo(src)).png).metadata()
  assert.equal(m.width, 50)
})
