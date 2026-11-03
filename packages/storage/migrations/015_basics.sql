-- 0.6.0 basics: reply deadlines, follow-up date, text blocks, "who has the case open".

-- Hours until a customer message should be answered, per platform (0 = no deadline).
-- Amazon expects 24 hours including weekends; the others are the operator's choice.
ALTER TABLE workspaces ADD COLUMN reply_deadlines jsonb NOT NULL
  DEFAULT '{"amazon":24,"ebay":48,"kaufland":48,"shop_apotheke":48,"docmorris":48,"shopify":48,"email":48}';

-- "Wartet" until this date; then the worker reopens the case. Kept after reopening as
-- the marker "Wiedervorlage" until a person or a new customer message changes the status.
ALTER TABLE conversations ADD COLUMN snooze_until timestamptz;
CREATE INDEX conversations_snooze ON conversations (snooze_until) WHERE status = 'waiting' AND snooze_until IS NOT NULL;

-- Text blocks the team writes once and reuses, with placeholders from the case and weclapp.
CREATE TABLE reply_snippets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX reply_snippets_workspace ON reply_snippets (workspace_id, title);

-- Who has a case open right now (heartbeat from the browser), so two people do not
-- answer the same customer. Rows older than a minute mean nothing.
CREATE TABLE case_presence (
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  editing boolean NOT NULL DEFAULT false,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id, user_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX case_presence_seen ON case_presence (seen_at);
