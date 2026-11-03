-- 0.7.0: topic of a case sorted on arrival (rules, no AI), and automation per topic.

ALTER TABLE conversations ADD COLUMN topic text
  CHECK (topic IN ('parcel_status','wrong_item','damaged_item','return_request','invoice','product_question','other'));
-- auto: keyword rules on arrival; ai: from an AI draft; person: set by hand (never overruled).
ALTER TABLE conversations ADD COLUMN topic_source text CHECK (topic_source IN ('auto','ai','person'));
CREATE INDEX conversations_topic ON conversations (workspace_id, topic);

-- Existing cases: take the topic of the latest written draft (a text block does not classify).
-- Cases without one are sorted by the worker with the keyword rules (sortUnsortedCases).
UPDATE conversations c SET topic = d.intent, topic_source = 'ai'
  FROM (SELECT DISTINCT ON (conversation_id) conversation_id, intent FROM drafts WHERE generated_by <> 'snippet' ORDER BY conversation_id, created_at DESC) d
 WHERE d.conversation_id = c.id AND d.intent IN ('parcel_status','wrong_item','damaged_item','return_request','invoice','product_question','other');

-- Per topic: {"parcel_status": {"mode": "off|draft|send", "since": "<iso>"}}. Invoices keep auto_invoice.
-- Only messages that arrive after switching a topic on are handled automatically.
ALTER TABLE workspaces ADD COLUMN automations jsonb NOT NULL DEFAULT '{}';
