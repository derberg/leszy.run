import { supabase } from '../lib/supabaseClient.js'
import crypto from 'crypto'
import sharp from 'sharp'

export async function eventPartnersRoutes(fastify) {
  // List partners for an event
  fastify.get('/events/:eventId/partners', async (request, reply) => {
    const { eventId } = request.params
    const { data, error } = await supabase
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
    const { name, website_url, sort_order } = request.body

    if (!name) return reply.status(400).send({ error: 'Name is required' })

    const { data, error } = await supabase
      .from('event_partners')
      .insert({ event_id: eventId, name, website_url: website_url || null, sort_order: sort_order ?? 0 })
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return reply.code(201).send({ data })
  })

  // Update partner
  fastify.patch('/partners/:id', async (request, reply) => {
    const { id } = request.params
    const updates = { ...request.body, updated_at: new Date().toISOString() }
    delete updates.id
    delete updates.event_id
    delete updates.created_at

    const { data, error } = await supabase
      .from('event_partners')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })

  // Delete partner (also removes logo from storage)
  fastify.delete('/partners/:id', async (request, reply) => {
    const { id } = request.params

    // Get partner to find logo path
    const { data: partner } = await supabase
      .from('event_partners')
      .select('logo_url')
      .eq('id', id)
      .single()

    if (partner?.logo_url) {
      const path = extractStoragePath(partner.logo_url)
      if (path) await supabase.storage.from('partner-logos').remove([path])
    }

    const { error } = await supabase
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

    const allowed = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
    if (!allowed.includes(file.mimetype)) {
      return reply.status(400).send({ error: 'Only PNG, JPEG, SVG, and WebP are allowed' })
    }

    const rawBuf = await file.toBuffer()

    // SVGs are already tiny and vector — skip compression
    const isSvg = file.mimetype === 'image/svg+xml'
    let buf, contentType, ext

    if (isSvg) {
      buf = rawBuf
      contentType = 'image/svg+xml'
      ext = 'svg'
    } else {
      buf = await sharp(rawBuf)
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      contentType = 'image/webp'
      ext = 'webp'
    }

    const storagePath = `${id}/${crypto.randomUUID()}.${ext}`

    // Remove old logo if exists
    const { data: partner } = await supabase
      .from('event_partners')
      .select('logo_url')
      .eq('id', id)
      .single()

    if (partner?.logo_url) {
      const oldPath = extractStoragePath(partner.logo_url)
      if (oldPath) await supabase.storage.from('partner-logos').remove([oldPath])
    }

    // Upload new logo
    const { error: uploadError } = await supabase.storage
      .from('partner-logos')
      .upload(storagePath, buf, { contentType, upsert: true })

    if (uploadError) return reply.status(500).send({ error: uploadError.message })

    const { data: urlData } = supabase.storage.from('partner-logos').getPublicUrl(storagePath)

    // Save URL to partner record
    const { data, error } = await supabase
      .from('event_partners')
      .update({ logo_url: urlData.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(500).send({ error: error.message })
    return { data }
  })

  // Delete logo only (keep partner)
  fastify.delete('/partners/:id/logo', async (request, reply) => {
    const { id } = request.params

    const { data: partner } = await supabase
      .from('event_partners')
      .select('logo_url')
      .eq('id', id)
      .single()

    if (partner?.logo_url) {
      const path = extractStoragePath(partner.logo_url)
      if (path) await supabase.storage.from('partner-logos').remove([path])
    }

    const { data, error } = await supabase
      .from('event_partners')
      .update({ logo_url: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })
}

function extractStoragePath(publicUrl) {
  if (!publicUrl) return null
  const marker = '/storage/v1/object/public/partner-logos/'
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return null
  return publicUrl.slice(idx + marker.length)
}
