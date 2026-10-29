-- Plan 2 final review I1 (ruling P2-R30): a custom consent somebody accepted is
-- locked after publish.
--
-- consent_acceptances stores only consent_id, so retyping an accepted consent
-- would make the acceptance point at text the runner never saw (Art. 7(1): the
-- controller must be able to show what was consented to), and deleting one hits
-- the ON DELETE RESTRICT foreign key and failed the whole publish with a 500.
--
-- registration_check_locks gains a `form` branch: when the staged value carries
-- `consents`, every custom consent of the event with at least one
-- consent_acceptances row must be listed (by id) with its text unchanged, else
-- `consent_locked`. Adding consents stays allowed, and a consent nobody
-- accepted may still be retyped or removed. The check runs at staging and again
-- inside publish_registration_changes, so a registration that lands between the
-- two is caught too.
--
-- CREATE OR REPLACE keeps the REVOKE from 20261029170000; it is repeated anyway.

CREATE OR REPLACE FUNCTION public.registration_check_locks(p_event_id uuid, p_section text, p_value jsonb) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_rs   public.registration_settings%ROWTYPE;
  v_item jsonb;
  v_comp public.competitions%ROWTYPE;
  v_mode text;
  v_old  integer;
BEGIN
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_section = 'basics' AND p_value ? 'slug' AND p_value->>'slug' IS DISTINCT FROM v_rs.slug THEN
    RAISE EXCEPTION 'immutable';
  END IF;
  IF p_section = 'timing' AND p_value ? 'timing_mode' AND p_value->>'timing_mode' IS DISTINCT FROM v_rs.timing_mode THEN
    RAISE EXCEPTION 'immutable';
  END IF;
  -- A custom consent somebody accepted stays, word for word (P2-R30).
  IF p_section = 'form' AND p_value ? 'consents' THEN
    IF EXISTS (
      SELECT 1 FROM public.event_consents ec
       WHERE ec.event_id = p_event_id AND ec.kind = 'custom'
         AND EXISTS (SELECT 1 FROM public.consent_acceptances ca WHERE ca.consent_id = ec.id)
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
                          WHERE k->>'id' = ec.id::text AND k->>'text' = ec.text)) THEN
      RAISE EXCEPTION 'consent_locked';
    END IF;
  END IF;
  IF p_section <> 'competitions' THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
     WHERE i->>'category_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.competitions c
                        WHERE c.category_id = (i->>'category_id')::uuid AND c.event_id = p_event_id)) THEN
    RAISE EXCEPTION 'foreign_id';
  END IF;
  -- After publish a competition is hidden, never deleted.
  IF EXISTS (
    SELECT 1 FROM public.competitions c
     WHERE c.event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
                        WHERE (i->>'category_id')::uuid = c.category_id)) THEN
    RAISE EXCEPTION 'competition_locked';
  END IF;

  v_mode := coalesce(p_value->>'pricing_mode', v_rs.pricing_mode);
  IF v_mode IS DISTINCT FROM v_rs.pricing_mode
     AND EXISTS (SELECT 1 FROM public.competitions c WHERE c.event_id = p_event_id AND c.taken > 0) THEN
    RAISE EXCEPTION 'price_locked';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
    CONTINUE WHEN v_item->>'category_id' IS NULL;
    SELECT * INTO v_comp FROM public.competitions WHERE category_id = (v_item->>'category_id')::uuid;
    CONTINUE WHEN v_comp.taken = 0;
    IF v_item ? 'kind' AND v_item->>'kind' IS DISTINCT FROM v_comp.kind THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_item ? 'hidden' AND (v_item->>'hidden')::boolean IS DISTINCT FROM (v_comp.hidden_at IS NOT NULL) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_mode = 'fixed' THEN
      SELECT p.amount INTO v_old
        FROM public.competition_prices p JOIN public.price_tiers t ON t.id = p.tier_id
       WHERE p.category_id = v_comp.category_id AND t.ends_on IS NULL
       ORDER BY t.sort_order LIMIT 1;
      IF (v_item->>'price')::integer IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'price_locked';
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_check_locks(uuid, text, jsonb) FROM public, anon, authenticated, service_role;
