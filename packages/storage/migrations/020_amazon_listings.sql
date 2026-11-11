-- Amazon Selling Partner API access of a workspace, used for one action: closing
-- a wrong offer from a case. LWA client secret and refresh token are encrypted in
-- secrets; the client ID is kept here but only shown masked.
CREATE TABLE amazon_listing_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region text NOT NULL CHECK (region IN ('eu', 'na', 'fe')),
  seller_id text NOT NULL,
  marketplace_ids text[] NOT NULL CHECK (cardinality(marketplace_ids) > 0),
  client_id text NOT NULL,
  secret_id uuid NOT NULL,
  -- Test doubles only (ALLOW_TEST_ENDPOINTS).
  api_base_url text,
  token_url text,
  status text NOT NULL DEFAULT 'configured',
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, secret_id) REFERENCES secrets(workspace_id, id)
);

-- What a person did to a marketplace listing from a case. Kept with the case.
CREATE TABLE listing_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'amazon' CHECK (platform IN ('amazon')),
  action text NOT NULL CHECK (action IN ('close_offer')),
  marketplace_id text NOT NULL,
  sku text NOT NULL,
  asin text,
  item_name text,
  -- pending: request on its way; accepted: Amazon took it for processing;
  -- rejected: Amazon refused (issues); uncertain: no answer, check at Amazon; failed: not sent.
  state text NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'uncertain', 'failed')),
  submission_id text,
  issues jsonb NOT NULL DEFAULT '[]',
  error text,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX listing_actions_case ON listing_actions (workspace_id, conversation_id, created_at);
-- One request at a time per offer: a double click cannot send twice.
CREATE UNIQUE INDEX listing_actions_one_pending ON listing_actions (workspace_id, platform, marketplace_id, sku) WHERE state = 'pending';
