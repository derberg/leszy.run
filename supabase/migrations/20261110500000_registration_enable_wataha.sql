-- Online registration for WATAHA L-PAAK, so the club can organize charity events.
-- Same switch as Zatyrani in 20261029100000_registration_foundation.sql. The club still has to accept
-- the organizer agreement before it can publish an event.
UPDATE public.clubs SET registration_enabled = true WHERE slug = 'wataha-lpaak';
