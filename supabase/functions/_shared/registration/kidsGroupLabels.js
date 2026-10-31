// The kids' group label of each registration (registrations.kids_group_id → kids_groups.label),
// for RA5: a child in a kids' run is shown by the group the form showed („Dzieci 2015–2017”),
// not by the age class. → Map<kids_group_id, label>
export async function kidsGroupLabels(admin, regs) {
  const ids = [...new Set((regs ?? []).map((r) => r.kids_group_id).filter(Boolean))]
  if (!ids.length) return new Map()
  const { data, error } = await admin.from('kids_groups').select('id, label').in('id', ids)
  if (error) throw error
  return new Map((data ?? []).map((g) => [g.id, g.label]))
}
