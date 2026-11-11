-- Sorting rules by subject pattern ("Dein SAFE-T-Antrag * wurde für die Bestellung * eingereicht"),
-- next to the existing sender rules. Every rule counts how many mails it has sorted.
ALTER TABLE category_rules DROP CONSTRAINT IF EXISTS category_rules_match_type_check;
ALTER TABLE category_rules ADD CONSTRAINT category_rules_match_type_check
  CHECK (match_type IN ('from_domain','from_address','subject_pattern'));
ALTER TABLE category_rules
  ADD COLUMN hits int NOT NULL DEFAULT 0,
  ADD COLUMN last_hit_at timestamptz;
