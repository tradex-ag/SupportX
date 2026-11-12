-- Refund list ("Erstattungen"): a person ticks off which refunds are done in the
-- ERP (credit note in weclapp). Cases appear on the list by their outcome
-- "Erstattet"/"Teilweise erstattet", by a marketplace refund notice, or when a
-- person adds them; this table stores only what people entered for a case.
-- SupportX itself never refunds and never writes to the ERP.
CREATE TABLE refund_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  conversation_id uuid NOT NULL,
  added_manually boolean NOT NULL DEFAULT false,
  -- Taken off the list by a person (e.g. a notice that is no refund for us).
  removed_at timestamptz,
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency text,
  note text,
  credit_note_number text,
  done_at timestamptz,
  done_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id)
);
CREATE INDEX refund_entries_done ON refund_entries (workspace_id, done_at DESC);
