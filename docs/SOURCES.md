# Source register

Research checked: **2026-10-21**. Dates below distinguish a documented release date from this review date. Sources are official vendor documentation or explicitly identified vendor-authored guidance. Summaries are original; external specifications and documentation are not redistributed under this repository's license.

Availability in documentation does not establish authorization for a particular account. A capability marked “not verified” means this review found no supporting public operation; it is not a claim that no private or future integration can exist. See [CONNECTORS.md](CONNECTORS.md) for implementation gates. Implementation status per connector is tracked in [CONNECTORS.md](CONNECTORS.md); as of 0.1.0 only Microsoft Graph mail and weclapp (read-only) are implemented, neither tested against a live account yet.

## Research versus first-build scope

The first build receives messages from the selected channels, looks up every order in **weclapp as its sole `OrderProvider`**, then replies through the original channel. Support emails from Shopify use Microsoft 365. No Shopify Admin order/fulfillment connector, Amazon SP-API order import, DocMorris Partner API order import or other parallel marketplace order synchronization is required.

Order API sources retained below are **reference-only for other installations**, not a roadmap commitment. Amazon SP-API documentation helps establish messaging limitations; it does not make SP-API registration a prerequisite for the email-relay implementation. Shopify Inbox remains a separate message-source question only if actually used. The project owner has confirmed that DocMorris enquiries arrive by email; this is account workflow information supplied by the owner, not evidence of a native messaging API. Include them in Microsoft ingestion; only the email reply route remains to be verified.

## Amazon

| ID | Source | Evidence used |
| --- | --- | --- |
| AMZ-1 | [Messaging API](https://developer-docs.amazon/sp-api/docs/messaging-api) | Outgoing order-specific actions, eligibility, seller availability and role/region matrix. |
| AMZ-2 | [Send a message](https://developer-docs.amazon/sp-api/docs/send-a-message) | Seller authorization, Buyer Communication role, action discovery and conditional custom text/attachments. |
| AMZ-3 | [Official Messaging API model](https://github.com/amzn/selling-partner-api-models/blob/main/models/messaging-api-model/messaging.json) | Public operation surface; no generic received-message inbox/reply operation verified. |
| AMZ-4 | [Notification Type Values](https://developer-docs.amazon/sp-api/docs/notification-type-values) | Reviewed event list; no buyer-message event verified. |
| AMZ-5 | [Setting Up Messaging Permissions](https://sellercentral.amazon.com/seller-forums/discussions/t/4e8db533-c64b-4425-8a8a-bbf099fec1b4) | Amazon-authored guidance by Xander_Amazon: authorized sender addresses and rejection of unauthorized senders. |
| AMZ-6 | [Buyer-Seller Messaging Best Practices](https://sellercentral.amazon.com/seller-forums/discussions/t/9cb18b7f-4442-4d2c-8459-ef1e1bdcbc3a) | Amazon-authored guidance by TaylorR_Amazon: relay email, Seller Central conversation visibility and fulfillment-context differences. |
| AMZ-7 | [SP-API Registration Overview](https://developer-docs.amazon/sp-api/docs/sp-api-registration-overview) | Reference-only registration guidance if another installation adds SP-API; not required for the first-build email relay. |
| AMZ-8 | [Data Retention and Recovery](https://developer-docs.amazon/sp-api/docs/protecting-amazon-api-applications-data-encryption-and-recovery) | SP-API retention and deletion reference; assess applicability to actual data sources, not as a reason to add an API import. |

Additional operational references: [Data encryption](https://developer-docs.amazon/sp-api/docs/protecting-amazon-api-applications-data-encryption); [DPP/AUP update published 2025-11-10](https://developer-docs.amazon/sp-api/changelog/updates-to-the-data-protection-policy-and-acceptable-use-policy); [current policies and agreements](https://developer-docs.amazon/sp-api/docs/policies-and-agreements).

## Microsoft

| ID | Source | Evidence used |
| --- | --- | --- |
| MS-1 | [Reply to a message](https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0) | Reply operation and permission requirements. |
| MS-2 | [Get incremental changes to messages](https://learn.microsoft.com/en-us/graph/delta-query-messages) | Folder-scoped delta synchronization and state tokens. |
| MS-3 | [Outlook change notifications overview](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview) | Message subscriptions and shared/delegated mailbox permission constraints. |
| MS-4 | [Application RBAC in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) | Mailbox-scoped application roles; independence from unscoped Entra grants. |
| MS-5 | [message: delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0) | Per-folder delta, `Prefer: odata.maxpagesize`, `$filter` limited to `receivedDateTime`, `@removed` entries, restart on invalid token (re-checked 2026-10-21 for the adapter). |
| MS-6 | [Create subscription](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0) | `Mail.Read` application permission for message subscriptions; validation token handshake; `clientState`; expiry/renewal. |
| MS-7 | [Mail API permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) | `Mail.Read` / `Mail.Send` application permissions; `Mail.Read.Shared` is delegated and not usable for app-only change notifications. |
| MS-8 | [message: forward](https://learn.microsoft.com/en-us/graph/api/message-forward?view=graph-rest-1.0) and [user: sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) | Forward: `comment` or `message.body` (not both), `toRecipients` or `message.toRecipients` (not both), `Mail.Send`, 202 Accepted, copy in Sent Items (checked 2026-11-11). Whether the original file attachments travel with the forward is not stated on the page and not yet tested against a live mailbox. |

Implementation note (2026-10-21): the Graph adapter reads via delta, fetches single messages with `Prefer: IdType="ImmutableId"`, replies with `POST /messages/{id}/reply` and embeds an `x-supportx-outbox-id` header for later reconciliation in Sent Items. Whether Exchange keeps that custom header on the sent copy has **not been tested against a live mailbox**; reconciliation degrades to a manual check if it does not.

## eBay

| ID | Source | Evidence used |
| --- | --- | --- |
| EBAY-1 | [Sell Communications Guide](https://developer.ebay.com/develop/guides/sell/sell-communications-guide) | Conversation retrieval, messaging, OAuth scope and notification integration. |
| EBAY-2 | [Commerce Message API release notes](https://developer.ebay.com/api-docs/commerce/message/release-notes.html) | Initial release on 2025-11-03. |
| EBAY-3 | [Notification API release notes](https://developer.ebay.com/api-docs/commerce/notification/static/release-notes.html) | `NEW_MESSAGE` addition on 2025-11-17. |
| EBAY-4 | [Commerce Message API OpenAPI 3](https://developer.ebay.com/api-docs/master/commerce/message/openapi/3/commerce_message_v1_oas3.json) | Checked 2026-10-22: base `/commerce/message/v1`, `GET /conversation`, `GET /conversation/{id}`, `POST /send_message`, scope `commerce.message`, field names used by the adapter. |
| EBAY-5 | [Marketplace account deletion](https://developer.ebay.com/marketplace-account-deletion) | Checked 2026-10-22: GET `challenge_code` answered with `challengeResponse` = sha256 hex of code + token + endpoint; token 32–80 of `A-Za-z0-9_-`; POST with `x-ebay-signature`, ack 200–204, 412 on bad signature, public key via Notification API `getPublicKey`, cache one hour. Algorithm/digest (ECDSA, SHA1 over the raw body) follow eBay's official notification SDKs; not yet verified with a real keyset. |

## Kaufland

| ID | Source | Evidence used |
| --- | --- | --- |
| KFL-1 | [Tickets](https://sellerapi.kaufland.com/?page=tickets) | Ticket/message workflow and customer-visible interim notices. |
| KFL-2 | [REST API](https://sellerapi.kaufland.com/?page=rest-api) | HMAC authentication and technology-partner requirements. |
| KFL-3 | [Push notifications](https://sellerapi.kaufland.com/?page=push-notifications) | Published event surface; ticket/message push not verified. |
| KFL-4 | [Endpoint reference, Tickets](https://sellerapi.kaufland.com/?page=endpoints#/Tickets) | Checked 2026-10-22 via a generated client of the published spec: `GET /tickets/messages` (`ts_created_from_iso`, `limit`, `offset`), `GET /tickets/{id}?embedded=buyer,order_units,messages`, message fields `id_ticket_message`, `id_ticket`, `author{role,name}`, `text`, `ts_created_iso`. |

## Shop Apotheke and Mirakl

| ID | Source | Evidence used |
| --- | --- | --- |
| SA-1 | [Shop Apotheke marketplace partner information](https://www.shop-apotheke.com/partner/marktplatz/) | Operator's use of Mirakl. |
| MIR-1 | [M11: List all threads](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/messages/m11) | Thread list, seek pagination, message inclusion limit, key scopes and synchronous-use guidance. |
| MIR-2 | [M10: Retrieve a thread](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/messages/m10) | Thread detail and synchronous-use guidance. |
| MIR-3 | [M12: Reply to a thread](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/messages/m12) | Documented thread reply operation. |

Generic Mirakl documentation does not prove a particular operator's account permissions or authorize unattended synchronization.

## DocMorris

**Account workflow confirmed by the project owner:** customer enquiries arrive by email. v1 uses the shared Microsoft connector and weclapp order context. The official references below describe API capabilities; they do not establish whether replies to this account's emails reach the correct customer-service thread. Verify that separately before outbound activation.

| ID | Source | Evidence used |
| --- | --- | --- |
| DM-1 | [DocMorris Partner API documentation](https://partner-api.docmorris.de/doc/) | Researched GraphQL design; order access is reference-only and out of first-build scope. |
| DM-2 | [Queries overview](https://partner-api.docmorris.de/doc/category/queries/) | Publicly listed query operations; no messaging query verified. |
| DM-3 | [Mutations overview](https://partner-api.docmorris.de/doc/category/mutations/) | Publicly listed mutations; no customer-reply mutation verified. |
| DM-4 | [Partner Logistics DE guide](https://partner-api.docmorris.de/doc/quickstart-guide/partner_logistics/complete-guide-pure-de/) | Reference-only SubOrders/JWT capability for other installations; not a required connector or credential for this build. |

## Shopify

| ID | Source | Evidence used |
| --- | --- | --- |
| SHOP-1 | [GraphQL Admin API: Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order) | Reference-only order API for other installations; excluded from first-build scope and not a messaging API. |
| SHOP-2 | [GraphQL Admin API: Fulfillment](https://shopify.dev/docs/api/admin-graphql/latest/objects/Fulfillment) | Reference-only fulfillment/tracking API; excluded from first-build scope. |
| SHOP-3 | [Installing and accessing Shopify Inbox](https://help.shopify.com/en/manual/inbox/setup) | Conditional research only if Inbox is actually used; documented web/mobile access does not establish a public conversation API. |

The first build handles Shopify support email through Microsoft and obtains order data solely from weclapp. The `latest` links are retained for reference; if a different installation independently elects to implement those APIs, it must select and test a supported fixed version. No public Shopify Inbox read/send operation was verified in this research.

## weclapp

| ID | Source | Evidence used |
| --- | --- | --- |
| WC-1 | [Official REST API v2 OpenAPI specification](https://www.weclapp.com/api/openapi_v2.yaml) | Sole first-build OrderProvider: AuthenticationToken header; sales-order, shipment and invoice resources; parcel tracking fields and deprecations. |
| WC-2 | [weclapp API entry point](https://www.weclapp.com/api/) | Official entry point for the versioned API specification and usage instructions. |

Credential replacement behavior must be checked against the operator's account before rotation. The specification link is a reference, not a bundled copy.

Implementation note (2026-10-21): the official specification URL was not reachable from the build environment. Field names used by the adapter (`salesOrder.orderNumberAtCustomer`, `ecommerceOrder.ecommerceId`, `shipment.mainSalesOrderId`, `shipment.parcels[].trackingId/trackingUrl`, deprecated `packageTrackingNumber/Url`, `salesInvoice.salesOrderId`, `<field>-eq` filters, `{ result: [...] }` envelope) were taken from documentation generated from the v2 OpenAPI file in a third-party SDK (github.com/kruegge82/weclapp-php-sdk, secondary source). **They must be confirmed against the operator's tenant** with `Verbindung prüfen` and one real order before relying on the matching.

## AI and MCP

| ID | Source | Evidence used |
| --- | --- | --- |
| AI-1 | [Claude: how tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works) | Structured tool requests are executed by the application; a model does not itself confer action authority. |
| AI-3 | Claude API skill/SDK reference (`@anthropic-ai/sdk` 0.137.0) | `messages.create` with `thinking: {type: "adaptive"}`, `output_config.effort`, `output_config.format` (JSON schema), `stop_reason` `refusal`/`max_tokens`, server-side refusal fallback beta. |
| AI-2 | [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture) | Host/client/server separation and provider-neutral tool/context exchange. |

## Open source

| ID | Source | Evidence used |
| --- | --- | --- |
| OS-1 | [GNU AGPL v3.0](https://choosealicense.com/licenses/agpl-3.0/) | Reuse and commercial use allowed; modified versions offered over a network must provide their source under the same license (section 13); section 7(b) allows requiring author attributions. |

## Updating this research

Before implementing a connector, reopen the relevant primary sources, record the selected API version and confirm account-specific access. Update the review date when evidence changes. Add contract tests using synthetic fixtures and record the outcome of authorized account validation separately from documentation research.
