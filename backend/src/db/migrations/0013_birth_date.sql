-- Add birth_date column and migrate from birth_year integer
ALTER TABLE participants ADD COLUMN birth_date date;

-- Migrate existing birth_year data to birth_date (default to Jan 1 of the year)
UPDATE participants SET birth_date = make_date(birth_year, 1, 1) WHERE birth_year IS NOT NULL;

-- Drop old birth_year column
ALTER TABLE participants DROP COLUMN birth_year;

-- Normalize gender: rename 'F' values to 'K' (Polish: Kobieta)
UPDATE participants SET gender = 'K' WHERE gender = 'F';
