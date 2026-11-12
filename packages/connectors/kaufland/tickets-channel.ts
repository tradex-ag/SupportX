import type { ConnectorCapabilities, IngressMessage, MessageChannel, ReconcileOutcome, ReplyOutcome, ReplyRequest, SyncResult } from "../../core/contracts.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";
import { cursorStart, isoOrNow, sameText, sendFailure, threadId } from "../marketplace-common.ts";
import { kauflandHeaders } from "./signing.ts";

/**
 * Kaufland Seller API v2 tickets as a message channel.
 *
 * Documentation reviewed 2026-10-22 (docs/SOURCES.md, KFL-1..KFL-4):
 * - GET /tickets/messages (ts_created_from_iso, limit, offset): all ticket
 *   messages of the seller; GET /tickets/{id_ticket}?embedded[0]=...&embedded[1]=...
 *   for one ticket with buyer, order_units and messages. `embedded` must be an
 *   indexed array: a comma list ("buyer,order_units") fails with HTTP 400
 *   "Validation Failed" (live, 2026-10-27).
 * - POST /tickets/{id_ticket}/messages {text, interim_notice}. interim_notice=true
 *   keeps the ticket open for the seller; the text is still customer-visible.
 * - No ticket/message push notification is documented: bounded polling only.
 *
 * Not yet verified with a real account: the exact `author.role` values, whether
 * the buyer's e-mail is exposed, and the format of `id_order` in weclapp.
 */
export interface KauflandTicketsConfig {
  clientKey: string;
  secretKey: string;
  /** Optional storefront filter (e.g. "de"); empty means all storefronts of the account. */
  storefronts?: ReadonlyArray<string>;
  initialSyncDays?: number;
  maxPagesPerSync?: number;
  baseUrl?: string;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
const PREFIX = "kaufland:ticket:";
/** Kaufland rejects larger pages with 400 "limit: max 30". */
const PAGE = 30;

interface TicketInfo {
  idOrders: string[];
  buyerName?: string;
  buyerEmail?: string;
  topic?: string;
  storefront?: string;
}

/** Kaufland date filter, without milliseconds: 2026-10-27T07:00:00Z. */
function kauflandTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Seller-side authors; everything else (buyer, Kaufland service) is inbound. */
function isSellerRole(role: unknown): boolean {
  return typeof role === "string" && /seller|merchant|partner/i.test(role);
}

export class KauflandTicketsChannel implements MessageChannel {
  readonly kind = "kaufland_tickets";
  readonly capabilities: ConnectorCapabilities = {
    receive: "configured",
    reply: "configured",
    attachments: "documented",
    pushNotifications: "not_implemented",
    sendReconciliation: "configured",
  };
  readonly ownAddresses: ReadonlyArray<string> = ["kaufland:seller"];
  readonly #config: KauflandTicketsConfig;
  readonly #base: string;

  constructor(config: KauflandTicketsConfig) {
    if (!config.clientKey?.trim() || !config.secretKey?.trim()) throw new Error("Kaufland Client Key und Secret Key werden benötigt.");
    this.#config = config;
    this.#base = assertAllowedEndpoint(config.baseUrl ?? "https://sellerapi.kaufland.com/v2", config.allowTestEndpoints ?? false, (u) => u.hostname === "sellerapi.kaufland.com")
      .toString()
      .replace(/\/+$/, "");
  }

  async #call(method: "GET" | "POST", path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<Json | null> {
    const url = new URL(`${this.#base}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = kauflandHeaders({ clientKey: this.#config.clientKey, secretKey: this.#config.secretKey, method, url: url.toString(), body: raw });
    return (await requestJson(url, { method, headers, body: raw || undefined, timeoutMs: this.#config.timeoutMs ?? 20_000, fetchImpl: this.#config.fetchImpl })) as Json | null;
  }

  async #ticket(id: string, embedded: ReadonlyArray<string>): Promise<Json> {
    const query = Object.fromEntries(embedded.map((name, i) => [`embedded[${i}]`, name]));
    const res = await this.#call("GET", `/tickets/${encodeURIComponent(id)}`, query);
    return ((res?.data ?? res) as Json) ?? {};
  }

  async #ticketInfo(id: string): Promise<TicketInfo> {
    const ticket = await this.#ticket(id, ["buyer", "order_units"]);
    const units = Array.isArray(ticket.order_units) ? (ticket.order_units as Json[]) : [];
    const idOrders = [...new Set(units.map((u) => u.id_order).filter((v): v is string | number => typeof v === "string" || typeof v === "number").map(String))];
    const buyer = (ticket.buyer ?? {}) as Json;
    const name = [buyer.firstname, buyer.lastname].filter((v) => typeof v === "string" && v).join(" ") || (typeof buyer.name === "string" ? buyer.name : undefined);
    return {
      idOrders,
      buyerName: name || undefined,
      buyerEmail: typeof buyer.email === "string" ? buyer.email.toLowerCase() : undefined,
      topic: typeof ticket.topic === "string" ? ticket.topic : typeof ticket.open_reason === "string" ? ticket.open_reason : undefined,
      storefront: typeof ticket.storefront === "string" ? ticket.storefront : undefined,
    };
  }

  #map(raw: Json, info: TicketInfo): IngressMessage {
    const ticketId = String(raw.id_ticket);
    const author = (raw.author ?? {}) as Json;
    const outbound = isSellerRole(author.role);
    const role = typeof author.role === "string" ? author.role.toLowerCase() : "unknown";
    const authorName = typeof author.name === "string" && author.name ? author.name : undefined;
    const customer = { address: info.buyerEmail ?? `kaufland:buyer:${ticketId}`, name: info.buyerName };
    const from = outbound ? { address: "kaufland:seller", name: authorName } : role.includes("buyer") || role.includes("customer") ? { ...customer, name: customer.name ?? authorName } : { address: `kaufland:${role}`, name: authorName ?? "Kaufland" };
    // The order number goes into the subject with a label, so the normal reference
    // extraction can look it up in weclapp. Never guessed from free text.
    const orders = info.idOrders.length ? ` · Bestellung ${info.idOrders.join(", Bestellung ")}` : "";
    return {
      externalMessageId: String(raw.id_ticket_message),
      externalThreadKey: `${PREFIX}${ticketId}`,
      resource: "tickets",
      direction: outbound ? "outbound" : "inbound",
      from,
      to: outbound ? [customer] : [{ address: "kaufland:seller" }],
      replyTo: [],
      subject: `Kaufland-Ticket ${ticketId}${info.topic ? ` (${info.topic})` : ""}${orders}`,
      bodyText: typeof raw.text === "string" ? raw.text.slice(0, 200_000) : "",
      receivedAt: isoOrNow(raw.ts_created_iso),
      headers: { "x-kaufland-ticket": ticketId, "x-kaufland-author-role": role, ...(info.storefront ? { "x-kaufland-storefront": info.storefront } : {}) },
      hasAttachments: Array.isArray(raw.files) && raw.files.length > 0,
      aliasKeys: [`kaufland:ticket:${ticketId}`, `kaufland:ticket:${ticketId}:message:${String(raw.id_ticket_message)}`],
    };
  }

  async sync(cursors: Readonly<Record<string, string>>): Promise<SyncResult> {
    const since = cursorStart(cursors.messages, this.#config.initialSyncDays ?? 14);
    const raws: Json[] = [];
    let offset = 0;
    let complete = false;
    for (let page = 0; page < (this.#config.maxPagesPerSync ?? 60); page++) {
      const res = await this.#call("GET", "/tickets/messages", { ts_created_from_iso: kauflandTime(since), limit: PAGE, offset });
      const data = Array.isArray(res?.data) ? (res!.data as Json[]) : [];
      raws.push(...data);
      const total = Number((res?.pagination as Json | undefined)?.total ?? NaN);
      offset += data.length;
      if (data.length < PAGE || (Number.isFinite(total) && offset >= total)) {
        complete = true;
        break;
      }
    }
    const infos = new Map<string, TicketInfo>();
    const messages: IngressMessage[] = [];
    let newest = cursors.messages ? new Date(cursors.messages).getTime() : 0;
    for (const raw of raws) {
      const ticketId = String(raw.id_ticket ?? "");
      if (!ticketId || raw.id_ticket_message === undefined) continue;
      if (!infos.has(ticketId)) infos.set(ticketId, await this.#ticketInfo(ticketId));
      const message = this.#map(raw, infos.get(ticketId)!);
      // Storefront filter is applied on the ticket, since the message list has no storefront parameter.
      const storefronts = this.#config.storefronts?.filter(Boolean) ?? [];
      if (storefronts.length && message.headers["x-kaufland-storefront"] && !storefronts.includes(message.headers["x-kaufland-storefront"])) continue;
      messages.push(message);
      newest = Math.max(newest, message.receivedAt.getTime());
    }
    // Only move the cursor after a complete round; an interrupted round is simply repeated.
    const next: Record<string, string> = complete ? { messages: new Date(newest || since.getTime()).toISOString() } : {};
    return { messages, removedExternalIds: [], cursors: next, cursorReset: false };
  }

  async sendReply(request: ReplyRequest): Promise<ReplyOutcome> {
    let ticketId: string;
    try {
      ticketId = threadId(request.externalThreadKey, PREFIX);
    } catch (error) {
      return { state: "rejected", error: (error as Error).message, retryable: false };
    }
    try {
      // interim_notice=false: a normal, customer-visible answer that hands the ticket back to the buyer.
      await this.#call("POST", `/tickets/${encodeURIComponent(ticketId)}/messages`, {}, {
        text: request.bodyText,
        interim_notice: false,
        // Documented as name, MIME type and base64 data (example uses a data URI).
        ...(request.attachments?.length ? { ticket_message_files: request.attachments.map((a) => ({ filename: a.name, mime_type: a.contentType, data: `data:${a.contentType};base64,${a.data.toString("base64")}` })) } : {}),
      });
      return { state: "provider_accepted" };
    } catch (error) {
      return sendFailure(error);
    }
  }

  async reconcileReply(_marker: string, since: Date, threadKey: string, sentBody: string): Promise<ReconcileOutcome> {
    try {
      const ticket = await this.#ticket(threadId(threadKey, PREFIX), ["messages"]);
      const from = since.getTime() - 5 * 60_000;
      for (const m of Array.isArray(ticket.messages) ? (ticket.messages as Json[]) : []) {
        if (!isSellerRole((m.author as Json | undefined)?.role)) continue;
        if (isoOrNow(m.ts_created_iso).getTime() < from) continue;
        if (typeof m.text === "string" && sameText(m.text, sentBody)) return { state: "found", externalMessageId: String(m.id_ticket_message) };
      }
      return { state: "not_found" };
    } catch (error) {
      return { state: "unknown", error: (error as Error).message };
    }
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.#call("GET", "/tickets", { limit: 1 });
      const total = (res?.pagination as Json | undefined)?.total;
      return { ok: true, detail: `Kaufland-Tickets lesbar${total !== undefined ? ` (${String(total)} Tickets)` : ""}.` };
    } catch (error) {
      return { ok: false, detail: error instanceof HttpError ? error.message : (error as Error).message };
    }
  }
}
