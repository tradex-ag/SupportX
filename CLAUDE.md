# Implementation brief for Claude Code

You are working on SupportX, a new independent project licensed under AGPL-3.0-only (attribution term in `NOTICE`; keep the UI credit line naming SupportX, ASEIO, TradeX International AG and Lars Orlamünde). Read `README.md`, `docs/BUILD_PLAN.de.md`, `docs/ARCHITECTURE.md`, `docs/CONNECTORS.md`, `docs/SOURCES.md`, `docs/ROADMAP.md` and the existing core before implementation.

## Current state (0.1.0)

The Microsoft + weclapp vertical slice (M1) and drafts/review/outbox (most of M2) are implemented: Fastify API + React UI, separate worker, PostgreSQL schema and migrations, Graph mail adapter, read-only weclapp adapter, Claude and rules `AiProvider`, approvals and outbox with uncertain-send reconciliation. All of it is tested only against local test doubles (`packages/testing`) and a real PostgreSQL; **no live Microsoft or weclapp account has been connected yet.** Since 0.2.0 native eBay (Commerce Message API + OAuth), Kaufland (tickets) and Mirakl/Shop Apotheke (inbox) channels exist, tested only against local test doubles in `packages/testing/fake-marketplaces.ts`. Attachments, MCP and action workflows are not implemented. Preserve this distinction in reports and UI. Do not describe a test double as a working live integration.

Working rules for this codebase:

- Node ≥ 22.12, TypeScript run directly via `tsx` (`.ts` import extensions, erasable syntax only). `npm run typecheck` and `npm test` must stay green; integration tests need `TEST_DATABASE_URL`.
- All business logic lives in `packages/services` and is shared by API, worker and a future MCP server. Every query is scoped by `workspace_id`; new tables need composite workspace foreign keys.
- Connectors are read-only unless a send is explicitly modelled through the outbox. Never rotate or create third-party credentials.
- The old dependency-free kernel (`packages/core/policy.ts`, `examples/demo.ts`, `tests/policy.test.ts`) is kept as a reference (`npm run kernel:demo`).

## Product intent

Build a self-hosted central support inbox for Microsoft email, Amazon, eBay, Kaufland, Shop Apotheke, DocMorris and Shopify-related enquiries. **The project owner has confirmed that all orders already live in weclapp. Use weclapp as the only order-data provider in v1. Do not build duplicate Shopify, Amazon or DocMorris order imports.** Receive a message, match the scoped order in weclapp, retrieve the necessary facts and reply through the original communication route. Claude is the first AI provider. Keep model providers and external MCP clients replaceable.

**DocMorris incoming customer enquiries arrive by email, as confirmed by the project owner.** Include them in the shared Microsoft ingestion in M1 and correlate them with weclapp orders. No separate DocMorris API connector is required for v1. Verify the actual email reply route before enabling outbound replies; incoming email alone does not prove that replies reach the customer-service thread.

## First implementation task

1. Inspect the supplied kernel and run its tests. Report actual implemented behavior and gaps.
2. Check the latest official API documentation for the specific adapter being implemented. Resolve real account permissions and sample payloads before assuming a capability. Do not invent credentials, endpoints or successful account tests.
3. Create the smallest real Microsoft + ERP vertical slice from M1, with workspace boundaries, server-side secrets, persistent ingestion, a reviewable inbox and explicit unknown-order handling.
4. Add a concrete schema, migrations, typed provider contracts, pinned toolchain and meaningful tests. Keep browser, worker and MCP authorization consistent.
5. Implement local drafts before live sending. Add live transport only when the selected account, route and operating policy have been configured and verified.
6. Document how to run the slice, what was tested and exactly which external tests remain blocked by absent access.

## Required architecture

- Modular TypeScript monolith with a web/API role and a separate worker.
- Independent PostgreSQL persistence with jobs/outbox; Docker Compose is the initial deployment target.
- Separate `MessageChannel`, `OrderProvider`, `AiProvider` and future financial/fulfillment `ActionProvider` contracts. Implement only weclapp behind `OrderProvider` in v1; extensibility is for future operators, not a requirement to add redundant platform imports.
- Workspace/account scope on every case, order lookup, attachment, secret, job and tool call.
- Per-connection configuration: users supply their own URLs and credentials through a protected server-side setup. No merchant-specific credential constants or browser storage of API secrets.
- Common server-side policy for UI, worker and MCP. AI returns proposals; it cannot grant itself permissions or choose arbitrary recipients.
- Evidence includes source, event time, retrieval time and explicit order/parcel association.
- Draft/approval/route revisions and atomic dispatch reservation. Uncertain sends must be reconciled before any retry.

## Platform constraints to preserve

- Amazon: the SP-API Messaging API is not a general inbound mailbox/reply API. Some eligible outgoing message types allow custom text. For normal dialogues use the authorized Buyer-Seller email relay through the Microsoft transport and validate the account-specific route.
- Microsoft: shared-mailbox change notifications require the appropriate application permission model. Scope real access to selected mailboxes and account for separately granted unscoped permissions. Follow `replyTo` semantics only after route/provenance validation. A successful API acceptance is not proof of customer delivery.
- eBay: prefer the current Commerce Message API over assuming only legacy Trading messages exist. A listing reference is not automatically an order ID.
- Kaufland: use tickets/messages. `interim_notice=true` is customer-visible, not an internal note. Do not assume ticket webhook availability.
- Shop Apotheke: Mirakl backend is documented. Verify allowed background synchronization; the public M10/M11 documentation does not justify a generic permanent poller. Derive recipients from the real thread participants.
- DocMorris: inbound email is confirmed and belongs in the shared Microsoft connector from M1. Preserve the original message identifiers, headers and order references. Validate Reply-To/provenance and a controlled end-to-end reply before activating outbound email. Its order API is not needed because order data comes from weclapp.
- Shopify: use support email through Microsoft. No direct Shopify order/fulfillment integration is in scope. Existing Shopify Inbox chats are a separate messaging question only if used by the operator.
- weclapp: extend/rebuild the read-only adapter to retrieve the existing orders and shipments. Verify exact field mapping and preserve multiple parcels. Check token rotation impact before replacing an existing credential.

## Automation constraints

Default to drafts. Start unattended operation with narrow versioned tracking templates after explicit per-account activation and verified evidence. Keep free-form generation in review until separately justified. Classify wrong-item and damage cases, reuse available evidence and prepare next steps; do not implicitly execute refunds, replacements, cancellations or return creation.

Never infer physical delivery from a label or tracking link. Never announce a refund/replacement as completed without a confirmed action result. Medical questions and potentially sensitive health content go to a dedicated human workflow. Do not expose unrelated case data to the model.

Use only facts returned by weclapp in the initial workflow. A direct carrier connection is not required. If the ERP contains a verified tracking reference but no live carrier status, implement a neutral link-only template without dispatch/delivery/ETA assertions. The current kernel's carrier-status template is a narrower demonstration and must not be represented as covering that separate workflow already.

## Verification that matters

Test wrong-workspace access, same order number on different accounts, ambiguous mapping, multi-parcel cases, stale data, duplicate ingress, true repeated customer messages, send echoes, expired approval, external manual replies and an ambiguous send timeout. Add provider contract tests from synthetic fixtures. Keep live acceptance tests controlled and separate from CI.

## Publication

Prepare a reviewable release with accurate capability status, setup instructions and license notices. Use the repository destination chosen by the project owner. Do not copy existing proprietary product code or publish real account data. Do not claim production readiness merely because local tests pass.
