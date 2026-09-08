-- TEST ONLY, not a real migration. Seeded deliberately to verify the
-- Migration filename hygiene CI job (OWB-T0179) catches a new file that
-- duplicates an existing migration's descriptive name at a different
-- timestamp. This PR is not meant to merge.
SELECT 1;
