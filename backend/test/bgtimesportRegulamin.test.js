import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickRegulaminFromHtml } from '../src/scrapers/sources/bgtimesport.js'

// Trimmed from https://www.bgtimesport.pl/zawody/regulamin/id/892
// (ZŁOTY GROŃ SKITUR ATAK 2026). The regulamins are Google Drive links, no PDF.
const DRIVE_PAGE = `
<ul><li class="active"><a href="/zawody/regulamin/id/892">REGULAMIN</a></li></ul>
<div>
  <a class="btn btn-link" href="https://drive.google.com/file/d/1oXqt0V2E4XxFQ7KC-vr4ixaWUxVTWxii/view?usp=sharing" target="_blank">Regulamin Turyści i dzieci</a>
  <a class="btn btn-link" href="https://drive.google.com/file/d/1lSPODhAm6y0B6cpa44fcv2y4IRCtd4Ga/view?usp=sharing" target="_blank">Regulamin Puchar Polski</a>
  <hr />
</div>
<h5><a href="/onas/regulamin-serwisu">Regulamin serwisu</a></h5>
`

test('bgtimesport: Drive regulamin is picked, main race over the kids/tourist one', () => {
  assert.equal(
    pickRegulaminFromHtml(DRIVE_PAGE),
    'https://drive.google.com/file/d/1lSPODhAm6y0B6cpa44fcv2y4IRCtd4Ga/view?usp=sharing',
  )
})

test('bgtimesport: a Drive link without "regulamin" in its text is not picked', () => {
  const html = `<a href="https://drive.google.com/file/d/abc/view">Oświadczenie</a>
    <a href="https://drive.google.com/drive/folders/xyz">Mapa trasy</a>`
  assert.equal(pickRegulaminFromHtml(html), null)
})

test('bgtimesport: Drive folder labelled regulamin is picked', () => {
  const html = `<a href="https://drive.google.com/drive/folders/xyz">Regulamin</a>`
  assert.equal(pickRegulaminFromHtml(html), 'https://drive.google.com/drive/folders/xyz')
})

test('bgtimesport: opaque PDF on the regulamin page still wins', () => {
  const html = `<a href="/upload/824reg20260228t234530.pdf">pobierz</a>
    <a href="https://drive.google.com/file/d/abc/view">Regulamin</a>`
  assert.equal(pickRegulaminFromHtml(html), 'https://www.bgtimesport.pl/upload/824reg20260228t234530.pdf')
})
