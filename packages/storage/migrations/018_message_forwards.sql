-- A person forwards one mail of a case to other addresses (supplier, colleague,
-- accounting). One row per send, its id is the marker header in the sent copy.
-- mode original: the mailbox forwards the original incl. attachments;
-- mode text: marketplace relay mails go out as a new mail with the text only,
-- relay addresses removed.
CREATE TABLE message_forwards (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipients text[] NOT NULL,
  comment text NOT NULL DEFAULT '',
  mode text NOT NULL CHECK (mode IN ('original','text')),
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending','sent','confirmed','uncertain','failed')),
  -- NULL: original forward, the mailbox sends the files with the original.
  attachments_included int,
  attachments_left_out text[] NOT NULL DEFAULT '{}',
  last_error text,
  external_message_id text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id),
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES channel_connections(workspace_id, id)
);
CREATE INDEX message_forwards_conversation ON message_forwards (workspace_id, conversation_id, created_at);
CREATE INDEX message_forwards_recent ON message_forwards (workspace_id, created_at DESC);
