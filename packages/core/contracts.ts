/**
 * Service-level extension contracts. Message transport, order context and AI
 * proposals are deliberately independent: a channel never looks up orders, an
 * order provider never sends messages, and an AI provider never gets routes,
 * recipients, credentials or send rights.
 */

/** Every persisted or executable object belongs to exactly one workspace. */
export interface WorkspaceScope {
  workspaceId: string;
}

/**
 * Three separate states, as required by the build plan: documented by the vendor,
 * configured for this installation, and verified with this concrete account.
 * Only `verified` may unlock unattended behaviour such as sending.
 */
export type CapabilityState = "not_implemented" | "documented" | "configured" | "verified";

export interface ConnectorCapabilities {
  receive: CapabilityState;
  reply: CapabilityState;
  attachments: CapabilityState;
  pushNotifications: CapabilityState;
  sendReconciliation: CapabilityState;
}

export type SourcePlatform =
  | "email"
  | "amazon"
  | "ebay"
  | "kaufland"
  | "shop_apotheke"
  | "docmorris"
  | "shopify";

export interface MessageAddress {
  address: string;
  name?: string;
}

/** A message as delivered by a channel adapter, before persistence. */
export interface IngressMessage {
  /** Stable provider id (Graph: immutable id). Unique per connection. */
  externalMessageId: string;
  /** RFC 5322 Message-ID when the transport has one. Used for duplicate detection. */
  internetMessageId?: string;
  /** Provider thread identity (Graph conversationId, eBay conversationId, Kaufland ticket id...). */
  externalThreadKey: string;
  /** Folder or resource the message was read from (e.g. inbox, sentitems). */
  resource: string;
  direction: "inbound" | "outbound";
  from: MessageAddress;
  to: ReadonlyArray<MessageAddress>;
  replyTo: ReadonlyArray<MessageAddress>;
  subject: string;
  bodyText: string;
  receivedAt: Date;
  /** Selected transport headers kept for provenance (Message-ID, In-Reply-To, References, x-supportx-*). */
  headers: Readonly<Record<string, string>>;
  hasAttachments: boolean;
  /**
   * Keys that let a later native adapter recognise an email copy of the same
   * platform message (e.g. "kaufland:ticket:123"). Only set when the connector
   * can derive them from trustworthy data; never from free text similarity.
   */
  aliasKeys: ReadonlyArray<string>;
}

export interface SyncResult {
  messages: ReadonlyArray<IngressMessage>;
  /** Items removed remotely; kept locally for audit, only flagged. */
  removedExternalIds: ReadonlyArray<string>;
  /** Opaque, per-resource cursors to persist after the batch is stored. */
  cursors: Readonly<Record<string, string>>;
  /** True when a cursor was invalid and the adapter restarted a full sync. */
  cursorReset: boolean;
}

export interface ReplyRequest {
  /** External id of the inbound message being answered; the transport derives the recipient from it. */
  inReplyToExternalId: string;
  /** Thread of the inbound message (Graph conversationId, `ebay:conversation:<id>`, `kaufland:ticket:<id>`...). */
  externalThreadKey: string;
  bodyText: string;
  /** Local outbox id, embedded so a later reconciliation can find the sent copy. */
  outboxMarker: string;
  /** Files approved together with the text (PDFs from the workspace documents). */
  attachments?: ReplyAttachment[];
}

export interface ReplyAttachment {
  name: string;
  contentType: string;
  data: Buffer;
}

/**
 * Forward one stored mail to addresses a person typed in. "original": the mailbox
 * forwards the message itself (Graph keeps body and file attachments). "text": a
 * new mail with prepared text only, for marketplace relay mails whose sender
 * address must not leave the mailbox.
 */
export type ForwardRequest =
  | { mode: "original"; externalMessageId: string; to: ReadonlyArray<string>; comment: string; marker: string }
  | { mode: "text"; to: ReadonlyArray<string>; subject: string; bodyText: string; marker: string; attachments?: ReplyAttachment[] };

export type ReplyOutcome =
  | { state: "provider_accepted"; externalMessageId?: string }
  /** The request may or may not have been executed (timeout, connection reset). */
  | { state: "uncertain"; error: string }
  /** The provider definitely rejected the request; nothing was sent. */
  | { state: "rejected"; error: string; retryable: boolean };

export type ReconcileOutcome =
  | { state: "found"; externalMessageId: string; internetMessageId?: string }
  | { state: "not_found" }
  | { state: "unknown"; error: string };

/** A file the customer attached to a message (listed on demand, never stored). */
export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface AttachmentFile extends AttachmentInfo {
  data: Buffer;
}

/**
 * Message transport adapter. Implementations: Microsoft Graph mail, eBay Commerce
 * Message API, Kaufland Seller API tickets and Mirakl inbox (Shop Apotheke).
 * Amazon is handled as a relay route on top of the Microsoft adapter. See
 * packages/connectors/catalog.ts for what is verified against a real account.
 */
export interface MessageChannel {
  readonly kind: string;
  readonly capabilities: ConnectorCapabilities;
  /** Mailbox/account identity used to recognise our own outbound messages. */
  readonly ownAddresses: ReadonlyArray<string>;
  /** Read changes since the stored cursors. Must be safe to repeat. */
  sync(cursors: Readonly<Record<string, string>>): Promise<SyncResult>;
  /** Attachments of one message, read live from the provider (optional per connector). */
  listAttachments?(externalMessageId: string, externalThreadKey: string): Promise<AttachmentInfo[]>;
  getAttachment?(externalMessageId: string, externalThreadKey: string, attachmentId: string): Promise<AttachmentFile>;
  /** Only the outbox worker may call this, after its atomic precondition check. */
  sendReply(request: ReplyRequest): Promise<ReplyOutcome>;
  /** Forward a mail to other addresses (mail connectors only). Called once per confirmed forward. */
  forwardMessage?(request: ForwardRequest): Promise<ReplyOutcome>;
  /**
   * Look for a sent copy after an uncertain send. Mail carries the outbox marker
   * header; marketplace APIs have no custom headers, so their adapters match our
   * own message in the thread by exact (normalised) text instead.
   */
  reconcileReply(marker: string, since: Date, threadKey: string, sentBody: string): Promise<ReconcileOutcome>;
  /** Cheap connectivity/permission check for the setup screen. */
  checkAccess(): Promise<{ ok: boolean; detail: string }>;
  /** The invoice document as the ERP renders it (read-only), for attaching to a reply. */
  downloadInvoicePdf?(invoiceId: string): Promise<{ data: Buffer; contentType: string }>;
}

// ---------------------------------------------------------------------------
// Order context

export interface OrderScopeRule {
  /**
   * Which weclapp field identifies orders of a merchant account. Verified on the
   * returned record, not only passed as a query filter.
   */
  field: "salesChannel" | "customerId" | "ecommerceConnectionId" | "tag" | "none";
  value: string;
}

export interface OrderLineFact {
  id: string;
  position?: number;
  title: string;
  articleId?: string;
  /** Article in the ERP the position is linked to (name may differ from the order title). */
  articleNumber?: string;
  articleName?: string;
  quantity: number;
  shippedQuantity?: number;
  returnedQuantity?: number;
  /** Line total incl. VAT and line discount in the order currency (weclapp salesOrderItem.grossAmount). */
  grossAmount?: number;
  /** Weight of one unit from the linked ERP article, in kg (weclapp articleGrossWeight / articleNetWeight). */
  grossWeightKg?: number;
  netWeightKg?: number;
}

export interface ParcelFact {
  id?: string;
  trackingId?: string;
  trackingUrl?: string;
  carrierId?: string;
  reference?: string;
  /** "parcels" (current) or "legacy_package_tracking" (deprecated single field). */
  source: "parcels" | "legacy_package_tracking";
  /** Weight booked on this parcel in the ERP, in kg. Not a carrier measurement unless the ERP took it from one. */
  weightKg?: number;
}

export interface ShipmentFact {
  id: string;
  shipmentNumber?: string;
  /** Status as recorded in the ERP. Not a carrier scan unless the ERP says so. */
  erpStatus?: string;
  erpStatusAt?: string;
  statusHistory: ReadonlyArray<{ status: string; at?: string }>;
  shippingDate?: string;
  deliveryDate?: string;
  items: ReadonlyArray<{ orderLineId?: string; title?: string; quantity: number }>;
  parcels: ReadonlyArray<ParcelFact>;
  /** Package weight booked on the shipment in the ERP, in kg (weclapp packageWeight). */
  weightKg?: number;
  /** Return labels weclapp created for this shipment (shippingReturnLabelsCount). A label alone is no return. */
  returnLabels?: number;
}

export type { ReturnFact } from "./returns.ts";
import type { ReturnFact } from "./returns.ts";

export interface InvoiceFact {
  id: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  status?: string;
  paymentStatus?: string;
  /** e.g. STANDARD_INVOICE, CREDIT_NOTE (weclapp salesInvoiceType). */
  type?: string;
  /** Total incl. VAT in the record currency (weclapp salesInvoice.grossAmount). */
  grossAmount?: number;
  /** Shipping cost items on this invoice or credit note, incl. VAT (sum of shippingCostItems[].grossAmount). */
  shippingGrossAmount?: number;
}

export interface OrderRecord {
  provider: "weclapp";
  id: string;
  orderNumber?: string;
  orderNumberAtCustomer?: string;
  orderDate?: string;
  status?: string;
  salesChannel?: string;
  ecommerceConnectionId?: string;
  customerId?: string;
  tags: ReadonlyArray<string>;
  lines: ReadonlyArray<OrderLineFact>;
  shipments: ReadonlyArray<ShipmentFact>;
  invoices: ReadonlyArray<InvoiceFact>;
  /**
   * Customer returns of this order. Undefined in snapshots taken before returns
   * were read (shown as "nicht geprüft"); an empty list means none was found.
   */
  returns?: ReadonlyArray<ReturnFact>;
  /** Reading the returns failed or was refused by the tenant; the list may be incomplete. */
  returnsError?: string;
  /** Order total incl. VAT and shipping (weclapp salesOrder.grossAmount). */
  grossAmount?: number;
  /** Shipping costs charged on the order, incl. VAT (sum of shippingCostItems[].grossAmount). */
  shippingGrossAmount?: number;
  /** Order currency, e.g. "EUR" (weclapp currency.name of recordCurrencyId); undefined when it could not be read. */
  currency?: string;
  /** True when amounts were read; snapshots taken before lack the flag and show no amount check. */
  amountsRead?: boolean;
  /** True when article and package weights were read; snapshots taken before lack the flag. */
  weightsRead?: boolean;
  /** When this application fetched the record. Event times are kept per fact. */
  retrievedAt: string;
}

export type OrderLookupResult =
  | { status: "unique"; order: OrderRecord; matchedBy: string }
  | { status: "ambiguous"; candidates: ReadonlyArray<{ id: string; orderNumber?: string; matchedBy: string }> }
  /** outOfScopeMatches: records with this reference exist, but only for another merchant account. */
  | { status: "missing"; triedReferences: ReadonlyArray<string>; outOfScopeMatches?: number; rejectedFilters?: ReadonlyArray<string> }
  | { status: "error"; error: string; retryable: boolean };

/** A number from the customer's message and where to look it up. */
export interface ReferenceQuery {
  value: string;
  kind: "order" | "invoice" | "tracking";
}

/** Read-only order context. weclapp is the only implementation in v1. */
export interface OrderProvider {
  readonly kind: "weclapp";
  findOrders(references: ReadonlyArray<ReferenceQuery>, scope: OrderScopeRule): Promise<OrderLookupResult>;
  getOrder(orderId: string, scope: OrderScopeRule): Promise<OrderLookupResult>;
  checkAccess(): Promise<{ ok: boolean; detail: string }>;
  /** The invoice document as the ERP renders it (read-only), for attaching to a reply. */
  downloadInvoicePdf?(invoiceId: string): Promise<{ data: Buffer; contentType: string }>;
}

// ---------------------------------------------------------------------------
// AI proposals

export type CaseIntent =
  | "parcel_status"
  | "wrong_item"
  | "damaged_item"
  | "return_request"
  | "invoice"
  | "product_question"
  | "other";

export type CaseRisk = "health" | "legal" | "refund" | "replacement" | "cancellation" | "delivery_disputed" | "identity_uncertain" | "abusive" | "other";

export type SuggestedAction = "none" | "ask_customer" | "check_return_label" | "propose_replacement" | "propose_refund" | "escalate";

/** A verified fact the model may use. Only facts in this list may be cited. */
export interface AllowedFact {
  id: string;
  text: string;
  source: string;
  observedAt?: string;
}

export interface ProposalInput {
  /** Conversation, oldest first. Internal notes are never included. */
  messages: ReadonlyArray<{ direction: "inbound" | "outbound"; text: string; at: string }>;
  facts: ReadonlyArray<AllowedFact>;
  /** Order matching outcome, so the model knows whether data is missing. */
  orderStatus: "unique" | "ambiguous" | "missing" | "error" | "not_checked";
  sourcePlatform: SourcePlatform;
  language: string;
  tone: string;
  signature: string;
  /** What a person decided before the reply is written. */
  decision?: ReplyDecision;
  /** Plausibility hints (e.g. pack size the customer names is not in the order). */
  hints?: ReadonlyArray<string>;
}

export type ReplyDecision = "customer_right" | "customer_wrong" | "ask_customer";

export interface PolishInput {
  text: string;
  messages: ProposalInput["messages"];
  facts: ReadonlyArray<AllowedFact>;
  language: string;
  tone: string;
  signature: string;
}

export interface Proposal {
  intent: CaseIntent;
  language: string;
  summary: string;
  replyText: string;
  citedFactIds: ReadonlyArray<string>;
  missingInformation: ReadonlyArray<string>;
  suggestedActions: ReadonlyArray<SuggestedAction>;
  risks: ReadonlyArray<CaseRisk>;
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  readonly promptVersion: string;
  propose(input: ProposalInput): Promise<Proposal>;
  /** Rewrite a person's text friendly and customer-oriented; only providers with a language model offer it. */
  polish?(input: PolishInput): Promise<string>;
}
