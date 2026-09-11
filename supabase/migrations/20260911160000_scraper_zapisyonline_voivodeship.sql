-- zapisyonline's listing carries only a bare city name, so voivodeship was left
-- to run-geocode. Nominatim resolves an ambiguous name to whichever village it
-- ranks first, which put four editions of Kosakowo Biega (Pomorskie, 81-198) in
-- Warmińsko-Mazurskie. The detail page's .address block carries the postal code,
-- which is unambiguous. The scraper now emits voivodeship from it, and the merge
-- already carries a source-set voivodeship through to scraper_all.
ALTER TABLE scraper_zapisyonline ADD COLUMN IF NOT EXISTS voivodeship text;
