import { supabase } from '../lib/supabaseClient.js'
import crypto from 'crypto'
import { partnerName, partnerNote, partnerUrl } from '../lib/partnerFields.js'
import { processPartnerLogo, PartnerLogoError } from '../lib/partnerLogo.js'

const BUCKET = 'partner-logos'
const DUPLICATE = { error: 'Taki partner już istnieje.' }
const PATCHABLE = ['name', 'note', 'website_url', 'is_public', 'sort_order']

/** Validates the partner fields present in `body`; returns { fields } or { error }. */
function validateFields(body, { requireName }) {
  const fields = {}
  if (body.name !== undefined || requireName) {
    const n = partnerName(body.name)
    if (n === null) return { error: 'Nazwa partnera: 1–80 znaków.' }
    fields.name = n
  }
  if (body.note !== undefined) {
    const v = partnerNote(body.note)
    if (v === undefined) return { error: 'Opis partnera: maks. 500 znaków.' }
    fields.note = v
  }
  if (body.website_url !== undefined) {
    const v = partnerUrl(body.website_url)
    if (v === undefined) return { error: 'Strona partnera: adres http(s), maks. 500 znaków.' }
    fields.website_url = v
  }
  if (body.is_public !== undefined) {
    if (typeof body.is_public !== 'boolean') return { error: 'is_public musi być wartością logiczną.' }
    fields.is_public = body.is_public
  }
  if (body.sort_order !== undefined) {
    if (!Number.isInteger(body.sort_order)) return { error: 'sort_order musi być liczbą całkowitą.' }
    fields.sort_order = body.sort_order
  }
  return { fields }
}

export async function eventPartnersRoutes(fastify, opts = {}) {
  const db = opts.client ?? supabase
  const bucket = () => db.storage.from(BUCKET)
  const removeLogo = async (partner) => {
    const path = partner?.logo_path || extractStoragePath(partner?.logo_url)
    if (path) await bucket().remove([path])
  }

  // List partners for an event
  fastify.get('/events/:eventId/partners', async (request, reply) => {
    const { eventId } = request.params
    const { data, error } = await db
      .from('event_partners')
      .select('*')
      .eq('event_id', eventId)
      .order('sort_order')

    if (error) return reply.status(500).send({ error: error.message })
    return { data }
  })

  // Create partner
  fastify.post('/events/:eventId/partners', async (request, reply) => {
    const { eventId } = request.params
    const body = request.body || {}
    const v = validateFields(body, { requireName: true })
    if (v.error) return reply.status(400).send({ error: v.error })

    const { data, error } = await db
      .from('event_partners')
      .insert({ sort_order: 0, ...v.fields, event_id: eventId })
      .select()
      .single()

    if (error?.code === '23505') return reply.status(409).send(DUPLICATE)
    if (error) return reply.status(400).send({ error: error.message })
    return reply.code(201).send({ data })
  })

  // Update partner (allow-list; the logo has its own routes)
  fastify.patch('/partners/:id', async (request, reply) => {
    const { id } = request.params
    const body = request.body || {}
    const unknown = Object.keys(body).filter((k) => !PATCHABLE.includes(k))
    if (unknown.length) return reply.status(400).send({ error: `Nieznane pole: ${unknown.join(', ')}` })
    const v = validateFields(body, { requireName: false })
    if (v.error) return reply.status(400).send({ error: v.error })

    const { data, error } = await db
      .from('event_partners')
      .update({ ...v.fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error?.code === '23505') return reply.status(409).send(DUPLICATE)
    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  // Delete partner (also removes logo from storage)
  fastify.delete('/partners/:id', async (request, reply) => {
    const { id } = request.params

    const { data: partner } = await db
      .from('event_partners')
      .select('logo_url, logo_path')
      .eq('id', id)
      .single()

    await removeLogo(partner)

    const { error } = await db
      .from('event_partners')
      .delete()
      .eq('id', id)

    if (error) return reply.status(400).send({ error: error.message })
    return { success: true }
  })

  // Upload logo for a partner
  fastify.post('/partners/:id/logo', async (request, reply) => {
    const { id } = request.params
    const file = await request.file()
    if (!file) return reply.status(400).send({ error: 'No file uploaded' })

    let png
    try {
      ;({ png } = await processPartnerLogo(await file.toBuffer()))
    } catch (e) {
      if (e instanceof PartnerLogoError) return reply.status(e.status).send({ error: e.message })
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(400).send({ error: 'Plik jest za duży (limit 2 MB).' })
      throw e
    }

    const storagePath = `${crypto.randomUUID()}.png`

    const { data: partner } = await db
      .from('event_partners')
      .select('logo_url, logo_path')
      .eq('id', id)
      .single()

    const { error: uploadError } = await bucket().upload(storagePath, png, { contentType: 'image/png' })
    if (uploadError) return reply.status(500).send({ error: uploadError.message })

    const { data: urlData } = bucket().getPublicUrl(storagePath)

    const { data, error } = await db
      .from('event_partners')
      .update({ logo_url: urlData.publicUrl, logo_path: storagePath, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      await bucket().remove([storagePath])
      return reply.status(500).send({ error: error.message })
    }
    // The new logo is saved; only now drop the old object (legacy rows have no logo_path).
    await removeLogo(partner)
    return { data }
  })

  // Delete logo only (keep partner)
  fastify.delete('/partners/:id/logo', async (request, reply) => {
    const { id } = request.params

    const { data: partner } = await db
      .from('event_partners')
      .select('logo_url, logo_path')
      .eq('id', id)
      .single()

    await removeLogo(partner)

    const { data, error } = await db
      .from('event_partners')
      .update({ logo_url: null, logo_path: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })
}

function extractStoragePath(publicUrl) {
  if (!publicUrl) return null
  const marker = `/storage/v1/object/public/${BUCKET}/`
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return null
  return publicUrl.slice(idx + marker.length)
}
