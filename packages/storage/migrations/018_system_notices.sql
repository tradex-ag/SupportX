-- Automatic marketplace notices to the seller (Amazon Seller Central: return authorisation,
-- refund issued, SAFE-T claim filed, …) were filed as requests with a reply deadline, because
-- they name an order. Sort existing ones out like the detection now does for new mails
-- (core/category.ts systemNoticeOf): every inbound mail of the case comes from the bare
-- amazon.<tld> domain (buyer mails come from marketplace.amazon.<tld>), the subject is no
-- claim against us, nothing was sent, and no person decided the category.
WITH notices AS (
  SELECT c.id, c.workspace_id
    FROM conversations c
   WHERE c.category = 'support'
     AND c.category_source <> 'person'
     AND c.subject !~* '(a-bis-z|a-to-z|garantieantrag|chargeback|rückbuchung)'
     AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.workspace_id = c.workspace_id AND o.conversation_id = c.id)
     AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.direction = 'inbound')
     AND NOT EXISTS (
       SELECT 1 FROM messages m
        WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.direction = 'inbound'
          AND (lower(m.from_address) !~ '@amazon\.(de|at|fr|it|es|nl|pl|se|ie|com\.be|com\.tr|co\.uk|com)$'
               OR m.subject ~* '(a-bis-z|a-to-z|garantieantrag|chargeback|rückbuchung)'))
), sorted AS (
  UPDATE conversations c SET category = 'info', category_source = 'auto', category_reason = 'Systemmeldung des Marktplatzes', updated_at = now()
    FROM notices WHERE c.id = notices.id
  RETURNING c.id, c.workspace_id
), drafts_closed AS (
  UPDATE drafts d SET status = 'superseded', updated_at = now()
    FROM sorted WHERE d.workspace_id = sorted.workspace_id AND d.conversation_id = sorted.id AND d.status IN ('proposed','edited')
  RETURNING d.id
)
UPDATE approvals a SET invalidated_at = now(), invalidation_reason = 'als Systemmeldung aussortiert'
  FROM sorted WHERE a.workspace_id = sorted.workspace_id AND a.conversation_id = sorted.id AND a.invalidated_at IS NULL;
