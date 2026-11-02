// An event's public partners, read with the anon key for the two cached JSON
// documents (/api/event and /api/results). RLS lets anon see only rows with
// is_public = true and only these columns: selecting any other one (note,
// is_public, logo_path) is an error, so the column list below is exact.
//
// Ordered sort_order, then id: created_at is not anon-readable, and id is a
// unique tie-break so the order, and with it the document's version hash, is
// stable.

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - an anon client
 * @param {string} eventId
 * @returns {Promise<Array<{ id: string, name: string, logoUrl: string|null, websiteUrl: string|null }>>}
 */
export async function readPublicPartners(supabase, eventId) {
  const { data, error } = await supabase.from('event_partners')
    .select('id, name, logo_url, website_url, sort_order')
    .eq('event_id', eventId)
    .order('sort_order').order('id')
    .range(0, 999)
  if (error) throw new Error(error.message)
  return data.map((p) => ({ id: p.id, name: p.name, logoUrl: p.logo_url ?? null, websiteUrl: p.website_url ?? null }))
}
