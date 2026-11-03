-- II Sztafeta Mikołajów (Szubin): the start pin sat on the centre of Szubin, because
-- the wizard's town search pinned the town and nothing looked up the address in
-- „Szczegóły miejsca” (Stadion Miejski, ul. Jana Pawła II 14). Nominatim puts that
-- address at 53.0007949, 17.7231619. The wizard now does this lookup itself (#401);
-- this moves the one event published before it.
--
-- Only while the pin is still the town centre, so a pin the organizer has moved
-- meanwhile stays. The event has no staged changes, so a later „Opublikuj zmiany”
-- carries no old pin back. On a local or CI stack the event does not exist and
-- nothing changes.

update public.registration_settings
   set lat = 53.0007949, lng = 17.7231619
 where event_id = '67806190-862d-4ef8-9be8-73c146818ad1'
   and lat = 53.011750 and lng = 17.743940;

update public.calendar_events
   set lat = 53.0007949, lng = 17.7231619
 where source = 'leszyrun'
   and source_id = '67806190-862d-4ef8-9be8-73c146818ad1'
   and lat = 53.011750 and lng = 17.743940;
