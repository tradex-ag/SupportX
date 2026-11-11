# SupportX

A self-hosted support inbox for marketplace sellers: Microsoft 365 mail in, order context from weclapp, AI-drafted replies, human review. Licensed under AGPL-3.0.

**An open-source product of [ASEIO](https://aseio.app)**, owned by TradeX International AG.

**Status: 0.3.0.** Native eBay, Kaufland and Shop Apotheke (Mirakl) message channels, Amazon, DocMorris and Shopify via the Microsoft mailbox. The Microsoft mailbox runs in production with a first merchant (drafts only). eBay, Kaufland, Mirakl and weclapp are tested against local test doubles and a real PostgreSQL only, **not yet against live accounts**. Sending is off by default, and this is not a production-ready helpdesk. See [Implementation status](docs/CONNECTORS.md#implementation-status-version-020-2026-10-22).

## What works

- **Ingestion:** Microsoft Graph delta sync of Inbox and Sent Items (shared mailboxes via application permissions), idempotent storage, expired-cursor recovery, optional change notifications. Own replies are recognised as echoes; replies sent manually in Outlook are recognised and withdraw open approvals.
- **Routing:** per-connection rules on sender/recipient/subject decide platform (DocMorris, Amazon relay, Shopify mail, …) and seller account. Message text can never select an account.
- **Matching:** order references (Amazon/eBay formats, labelled numbers) are looked up read-only in weclapp, first within the case's seller account (e.g. `salesChannel`), then in all of weclapp; a unique hit fills in the fitting seller account. Results are *eindeutig*, *unklar* (several candidates to pick from), *nicht gefunden*, *keine Bestellnummer* or *Fehler*, all visible for manual review. All shipments and parcels are kept.
- **Drafts:** `AiProvider` with Claude (`claude-opus-5-5`, structured output) or deterministic German templates. Drafts may only use facts from weclapp; a server-side check blocks unknown facts, unapproved links, unsupported dispatch/delivery claims and “refund done”-style statements. Health questions are flagged for qualified review. Internal notes never reach the model.
- **Review and sending:** editable drafts, versioned approvals that expire and are invalidated by a new customer message or an edit, an outbox with exactly one live reply per customer message, and explicit `delivery_uncertain` handling with reconciliation in Sent Items instead of retries. Sending needs `SEND_MODE=enabled`, a per-connection switch and a recorded reply-route verification per platform.
- **Isolation:** workspaces and seller accounts on every row (composite foreign keys), encrypted connector secrets (AES-256-GCM), session cookies with CSRF header, roles owner/agent/viewer.
- **Web UI** (German): case list with filters, case view with history, order/shipments/parcels/invoices, account and manual order assignment, notes, draft editor, approval/send, outbox status, audit log; settings for accounts, weclapp, Microsoft mailboxes, routing rules, verified reply routes and connector status.

- **Marketplace channels:** eBay Commerce Message API (OAuth per seller account), Kaufland Seller API tickets (HMAC), Shop Apotheke via the Mirakl inbox (read on demand unless the operator allowed background reads). Same drafts, approvals and outbox as mail; not yet tested against live accounts.

- **Invoices and files (0.5.0):** "Rechnung senden" fetches the invoice PDF of the linked order from weclapp (read-only, `downloadLatestSalesInvoicePdf`) and attaches it to a template reply (no AI cost); "Datei anhängen" adds a PDF/JPG/PNG to one reply. Optional per workspace: recognise invoice requests on arrival and prepare or send the invoice reply on its own (narrow rule `invoice-v1`; never when the order is unclear, the channel takes no files, the customer names an own address, or any check warns). Tested against local test doubles only.

- **Everyday basics (0.6.0):** reply deadline per platform (Amazon 24 h by default, editable, 0 = none) as a traffic light in the list, open cases sorted by the deadline that runs out first; the clock starts at the first unanswered customer message and also stops for Amazon's copy of a reply sent in Seller Central. Search over all cases (order and parcel numbers, name, address, text). Text blocks with placeholders filled from the case and weclapp (`{Name}`, `{Bestellnummer}`, `{Sendungsnummer}`, `{Trackinglink}` …), as a reply or inserted into a draft, no AI cost; an unfilled placeholder blocks approval. Marketplace messaging rules in the draft check (warnings: e-mail addresses or phone numbers, advertising, on Amazon also review requests and links the order does not need). "Who has the case open / is writing" for two or more people. "Wartet" with a follow-up date that reopens the case.
- **Topics and automation per topic (0.7.0):** every case is sorted by topic on arrival (keyword rules, no AI; an AI draft may refine it, a person can change it and the choice is never overruled), the list filters by topic. Automation for "Wo ist mein Paket?" (off / prepare / send): a fixed template with delivery state and tracking links from weclapp, no AI cost. It only sends when the order is unique, every shipment has a tracking link, the message has no sensitive topic, the draft check has no hint and sending is enabled for the channel; otherwise the reply waits in the case with the reason. Only messages after switching it on are handled.
- **Team tools (0.8.0):** customer history in the case (earlier cases of the same address or weclapp customer, with what was done: refund, replacement, return). Approve several ready replies at once on one page with their full text; drafts with hints or a closed send route are shown but only approved one by one. "Auswertung": cases per topic and channel, first reply time, deadline kept, outcomes, and damage/wrong-item/return cases per weclapp article (7/30/90 days, own data only). Cases with a red deadline in the inbox and the tab title, optional browser notification. Evidence PDF per case for Amazon A-to-z or eBay claims: order, shipments with tracking, invoices and the whole conversation incl. Seller Central replies.

- **Forward a mail (0.11.0):** "Weiterleiten" under every mail of a case from the Microsoft mailbox: several recipients (suggestions from earlier forwards), optional own text, a confirmation step, then the mailbox forwards the original with its attachments (`Fwd:` subject). Marketplace relay mails (Amazon, eBay, Kaufland, Shop Apotheke, or a relay sender) go out as a new mail with the text only, all e-mail addresses removed, attachments up to 3 MB. Logged in the history ("Weitergeleitet an … am …"); the sent copy confirms it without counting as a reply; a timeout stays "ungeklärt" until checked in Sent Items, never resent on its own. Needs `SEND_MODE=enabled` and sending switched on for the mailbox. Tested against local test doubles only; whether Exchange keeps the attachments and the marker header on a real forward is still to verify.

Not yet: MCP server, refund/replacement/return workflows, free-form automatic replies.

## Quick start (demo, no credentials)

Requires Node.js ≥ 22.12 and PostgreSQL 16 with a database `supportx` for user `supportx`/`supportx` (or set `DATABASE_URL`).

```bash
npm ci
npm run demo
```

Open http://localhost:3000 and sign in as `service@demo-haendler.example.invalid` / `demo-passwort-nur-lokal` (owner: `inhaber@…`). The demo starts local stand-ins for weclapp and Graph with **synthetic** data; the real adapters talk to them over HTTP. The UI shows a DEMO banner.

## Real setup

German guide: [docs/SETUP.de.md](docs/SETUP.de.md) (environment, first admin, weclapp read-only user, Entra app + Exchange RBAC scoping, routing rules, Claude, enabling replies). Configuration template: [.env.example](.env.example). Docker: `docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build` (single-server production setup with Caddy, optional pull-based auto-updates, see the German guide).

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply SQL migrations |
| `npm run admin:create -- --email … --workspace …` | First owner + workspace (`SUPPORTX_ADMIN_PASSWORD` env) |
| `npm run start:server` / `npm run start:worker` | Web/API and background worker (separate processes) |
| `npm run dev` | Server + worker with reload, Vite dev server on :5173 |
| `npm run typecheck` | `tsc` for server and web |
| `npm test` | Unit, adapter-contract, DB integration and API tests (needs `TEST_DATABASE_URL`, default `postgres://supportx:supportx@127.0.0.1:5432/supportx_test`) |

## Layout

```
apps/server   Fastify HTTP API, serves the built UI
apps/worker   job loop: mail sync, matching, drafts, outbox dispatch/reconcile
apps/web      React UI (Vite)
packages/core        contracts (MessageChannel, OrderProvider, AiProvider), references, routing, facts, draft checks
packages/connectors  Microsoft Graph mail, weclapp v2 (read-only), connector catalog
packages/ai          Claude provider, rules provider, prompt and proposal schema
packages/services    application services shared by API, worker and a future MCP server
packages/storage     config, PostgreSQL, migrations, secret encryption
packages/testing     test doubles and synthetic demo data
```

## Documentation

| File | Purpose |
| --- | --- |
| [Setup (German)](docs/SETUP.de.md) | Installation and account configuration |
| [Build brief (German)](docs/BUILD_PLAN.de.md) | Product scope and decisions |
| [Architecture](docs/ARCHITECTURE.md) | Identity, ingestion, evidence, policy, delivery, AI boundaries |
| [Connectors](docs/CONNECTORS.md) | Implementation status, researched capabilities, account test gates |
| [Sources](docs/SOURCES.md) | Official references |
| [Roadmap](docs/ROADMAP.md) | Milestones |
| [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) | |

## Platform approach

weclapp is the only order-data source; there are no order imports from Shopify, Amazon, eBay, Kaufland or DocMorris. DocMorris, Amazon (Buyer-Seller relay) and Shopify enquiries arrive as email through Microsoft. eBay (Commerce Message API), Kaufland (tickets) and Shop Apotheke (Mirakl) are planned as native channels behind the same `MessageChannel` contract.

## License and self-hosting

GNU Affero General Public License v3.0 (AGPL-3.0-only), see [LICENSE](LICENSE), with the attribution term in [NOTICE](NOTICE). Copyright TradeX International AG, author Lars Orlamünde.

In short: anyone may use, change, run commercially and redistribute SupportX. In return:

- **Keep the attribution.** Every copy and every derived version keeps the copyright notice, the NOTICE file and the visible credit line in the user interface naming SupportX, ASEIO, TradeX International AG and Lars Orlamünde (AGPL section 7(b)).
- **Share your changes.** Whoever distributes a modified version, or lets other people use it over a network (for example a hosted support inbox), must offer them the complete source code of that version under the same license (AGPL section 13). Mark your changes.
- **Please send them back.** We ask that improvements come back as a pull request to [tradex-ag/SupportX](https://github.com/tradex-ag/SupportX), see [CONTRIBUTING.md](CONTRIBUTING.md). The license requires publishing changes, not sending them to us; the pull request is the way to get them into the original.

Versions up to and including 0.9.1 were published under MIT; copies obtained under MIT keep those terms. The names „SupportX“ and „ASEIO“ and their logos are not covered by the license; forks please use their own name. Operators bring their own Microsoft tenant, weclapp account, AI provider key and hosting. The license does not grant platform access or waive platform terms. No proprietary application code or real customer records are included; demo data uses reserved `.invalid` domains.
