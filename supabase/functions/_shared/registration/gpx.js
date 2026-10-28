// GPX parsing without a DOM (Deno has no DOMParser). Regex extraction of trkpt/rtept, haversine distance,
// climb with 3 m hysteresis. Plain ESM: runs in Deno and Node.

export class GpxError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GpxError'
  }
}

const MAX_POINTS = 500
const MAX_PROFILE = 200
const HYSTERESIS_M = 3
const EARTH_KM = 6371.0088

function haversineKm(a, b) {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

function extractPoints(text, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g')
  const pts = []
  for (const m of text.matchAll(re)) {
    const lat = /\blat\s*=\s*["']([^"']+)["']/.exec(m[1])
    const lon = /\blon\s*=\s*["']([^"']+)["']/.exec(m[1])
    if (!lat || !lon) continue
    const la = Number(lat[1])
    const lo = Number(lon[1])
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue
    const ele = m[2] ? /<ele>\s*([^<\s]+)\s*<\/ele>/.exec(m[2]) : null
    const e = ele ? Number(ele[1]) : NaN
    pts.push({ lat: la, lng: lo, ele: Number.isFinite(e) ? e : null })
  }
  return pts
}

function downsample(arr, max) {
  if (arr.length <= max) return arr
  const out = []
  for (let i = 0; i < max; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (max - 1))])
  return out
}

function climb(eles) {
  let up = 0
  let down = 0
  let anchor = null
  for (const e of eles) {
    if (anchor == null) { anchor = e; continue }
    if (e - anchor >= HYSTERESIS_M) { up += e - anchor; anchor = e }
    else if (anchor - e >= HYSTERESIS_M) { down += anchor - e; anchor = e }
  }
  return { up, down }
}

/** @returns {{ km: number, upM: number, downM: number, points: number[][], profile: number[][], bounds: object }} */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<gpx[\s>]/i.test(text)) throw new GpxError('To nie jest plik GPX.')
  let pts = extractPoints(text, 'trkpt')
  if (pts.length === 0) pts = extractPoints(text, 'rtept')
  if (pts.length < 2) throw new GpxError('Plik GPX nie zawiera trasy.')

  let km = 0
  const cum = [0]
  for (let i = 1; i < pts.length; i++) {
    km += haversineKm(pts[i - 1], pts[i])
    cum.push(km)
  }

  const eles = pts.map((p) => p.ele).filter((e) => e != null)
  const { up, down } = climb(eles)

  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity
  for (const p of pts) {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat)
    west = Math.min(west, p.lng); east = Math.max(east, p.lng)
  }

  const idx = pts.map((_, i) => i)
  const points = downsample(idx, MAX_POINTS).map((i) => [Number(pts[i].lat.toFixed(5)), Number(pts[i].lng.toFixed(5))])
  const withEle = idx.filter((i) => pts[i].ele != null)
  const profile = downsample(withEle, MAX_PROFILE).map((i) => [Number(cum[i].toFixed(3)), Math.round(pts[i].ele)])

  return {
    km: Number(km.toFixed(2)),
    upM: Math.round(up),
    downM: Math.round(down),
    points,
    profile,
    bounds: { south, west, north, east },
  }
}
