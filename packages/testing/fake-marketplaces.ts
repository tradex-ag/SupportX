import { generateKeyPairSync, sign, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signKauflandRequest } from "../connectors/kaufland/signing.ts";

/**
 * Local stand-ins for the marketplace message APIs, built from the documented
 * request/response shapes (docs/SOURCES.md). Synthetic data only. They check
 * authentication (Kaufland HMAC, eBay bearer from refresh token, Mirakl key),
 * record every request and can inject send faults. They do not claim any
 * behaviour beyond what the documentation describes.
 */
export type SendFault = "none" | "timeout_after_send" | "server_error_after_send" | "reject_400";

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function sendWithFault(fault: SendFault, res: ServerResponse, apply: () => unknown, okStatus: number, hangMs: number): Promise<void> {
  if (fault === "reject_400") return json(res, 400, { message: "invalid request" });
  const result = apply();
  if (fault === "timeout_after_send") {
    await new Promise((r) => setTimeout(r, hangMs));
    return json(res, okStatus, result);
  }
  if (fault === "server_error_after_send") return json(res, 503, { message: "unavailable" });
  return json(res, okStatus, result);
}

// ---------------------------------------------------------------------------
// Kaufland Seller API v2

export interface FakeKauflandMessage {
  id_ticket_message: number;
  id_ticket: string;
  author: { role: string; name: string };
  text: string;
  ts_created_iso: string;
}

export interface FakeKauflandTicket {
  id_ticket: string;
  storefront: string;
  topic: string;
  id_order: string;
  buyer: { firstname: string; lastname: string; email?: string };
}

export interface FakeKaufland {
  baseUrl: string;
  tickets: FakeKauflandTicket[];
  messages: FakeKauflandMessage[];
  posted: Array<{ ticketId: string; text: string; interim_notice: unknown; files: Array<{ filename: string; mime_type: string; data: string }> }>;
  requests: string[];
  addTicket(t: Omit<FakeKauflandTicket, "storefront" | "topic"> & Partial<Pick<FakeKauflandTicket, "storefront" | "topic">>): void;
  addMessage(ticketId: string, role: string, text: string, at?: Date): FakeKauflandMessage;
  setSendFault(fault: SendFault): void;
  close(): Promise<void>;
}

export async function startFakeKaufland(opts: { clientKey: string; secretKey: string; hangMs?: number }): Promise<FakeKaufland> {
  const tickets: FakeKauflandTicket[] = [];
  const messages: FakeKauflandMessage[] = [];
  const posted: FakeKaufland["posted"] = [];
  const requests: string[] = [];
  let nextId = 1000;
  let fault: SendFault = "none";
  let origin = "";
  const add = (ticketId: string, role: string, text: string, at = new Date()): FakeKauflandMessage => {
    const m = { id_ticket_message: nextId++, id_ticket: ticketId, author: { role, name: role === "seller" ? "Shop" : "Kunde" }, text, ts_created_iso: at.toISOString() };
    messages.push(m);
    return m;
  };

  const server = createServer(async (req, res) => {
    const body = (await readBody(req)).toString("utf8");
    const url = new URL(req.url ?? "/", origin);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const expected = signKauflandRequest({ method: req.method ?? "GET", url: url.toString(), body, timestamp: Number(req.headers["shop-timestamp"]), secretKey: opts.secretKey });
    const got = String(req.headers["shop-signature"] ?? "");
    if (req.headers["shop-client-key"] !== opts.clientKey || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      return json(res, 401, { message: "invalid signature" });
    }
    const path = url.pathname.replace(/^\/v2/, "");
    if (req.method === "GET" && path === "/tickets") return json(res, 200, { data: tickets.slice(0, 1), pagination: { offset: 0, limit: 1, total: tickets.length } });
    if (req.method === "GET" && path === "/tickets/messages") {
      const fromParam = url.searchParams.get("ts_created_from_iso") ?? "1970-01-01T00:00:00Z";
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fromParam)) return json(res, 400, { message: "Validation Failed", errors: [{ property: "ts_created_from_iso", message: "Invalid date format." }] });
      const from = new Date(fromParam).getTime();
      const all = messages.filter((m) => new Date(m.ts_created_iso).getTime() >= from);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 30);
      // Same rule as the real API (seen live 2026-11-12).
      if (limit > 30) return json(res, 400, { message: "Validation Failed", errors: [{ property: "limit", message: "max 30" }] });
      return json(res, 200, { data: all.slice(offset, offset + limit), pagination: { offset, limit, total: all.length } });
    }
    const ticketMatch = /^\/tickets\/([^/]+)$/.exec(path);
    if (req.method === "GET" && ticketMatch) {
      const t = tickets.find((x) => x.id_ticket === decodeURIComponent(ticketMatch[1]!));
      if (!t) return json(res, 404, { message: "not found" });
      // Like the real API: `embedded` only as an indexed array, a comma list is rejected.
      if (url.searchParams.has("embedded")) return json(res, 400, { message: "Validation Failed", errors: [{ property: "embedded", message: "This value should be of type array." }] });
      const embedded = [...url.searchParams.entries()].filter(([k]) => /^embedded\[\d+\]$/.test(k)).map(([, v]) => v);
      return json(res, 200, {
        data: {
          id_ticket: t.id_ticket, status: "opened", topic: t.topic, storefront: t.storefront, is_seller_responsible: true,
          ...(embedded.includes("buyer") ? { buyer: t.buyer } : {}),
          ...(embedded.includes("order_units") ? { order_units: [{ id_order_unit: 1, id_order: t.id_order }] } : {}),
          ...(embedded.includes("messages") ? { messages: messages.filter((m) => m.id_ticket === t.id_ticket) } : {}),
        },
      });
    }
    const postMatch = /^\/tickets\/([^/]+)\/messages$/.exec(path);
    if (req.method === "POST" && postMatch) {
      const ticketId = decodeURIComponent(postMatch[1]!);
      const parsed = JSON.parse(body) as { text: string; interim_notice?: unknown; ticket_message_files?: Array<{ filename: string; mime_type: string; data: string }> };
      return sendWithFault(fault, res, () => {
        posted.push({ ticketId, text: parsed.text, interim_notice: parsed.interim_notice, files: parsed.ticket_message_files ?? [] });
        add(ticketId, "seller", parsed.text);
        return undefined;
      }, 201, opts.hangMs ?? 400);
    }
    return json(res, 404, { message: "unknown endpoint" });
  });
  origin = await listen(server);
  return {
    baseUrl: `${origin}/v2`,
    tickets,
    messages,
    posted,
    requests,
    addTicket: (t) => tickets.push({ storefront: "de", topic: "product_not_received", ...t }),
    addMessage: add,
    setSendFault: (f) => (fault = f),
    close: () => close(server),
  };
}

// ---------------------------------------------------------------------------
// eBay OAuth + Commerce Message API

export interface FakeEbayMessage {
  messageId: string;
  conversationId: string;
  senderUsername: string;
  recipientUsername: string;
  messageBody: string;
  createdDate: string;
}

export interface FakeEbay {
  baseUrl: string;
  conversations: Array<{ conversationId: string; conversationTitle: string; referenceId?: string; type: "FROM_MEMBERS" | "FROM_EBAY"; createdDate: string }>;
  messages: FakeEbayMessage[];
  sent: Array<{ conversationId: string; messageText: string }>;
  tokenRequests: URLSearchParams[];
  requests: string[];
  addConversation(input: { id: string; title: string; buyer: string; text: string; type?: "FROM_MEMBERS" | "FROM_EBAY"; referenceId?: string; at?: Date }): FakeEbayMessage;
  addMessage(conversationId: string, from: string, to: string, text: string, at?: Date): FakeEbayMessage;
  setSendFault(fault: SendFault): void;
  close(): Promise<void>;
}

export async function startFakeEbay(opts: { clientId: string; clientSecret: string; seller: string; authCode: string; refreshToken: string; hangMs?: number; publicKeys?: Record<string, { algorithm: string; digest: string; key: string }> }): Promise<FakeEbay> {
  const conversations: FakeEbay["conversations"] = [];
  const messages: FakeEbayMessage[] = [];
  const sent: FakeEbay["sent"] = [];
  const tokenRequests: URLSearchParams[] = [];
  const requests: string[] = [];
  let seq = 1;
  let fault: SendFault = "none";
  const accessToken = "fake-ebay-access";
  const addMessage = (conversationId: string, from: string, to: string, text: string, at = new Date()): FakeEbayMessage => {
    const m = { messageId: `m${seq++}`, conversationId, senderUsername: from, recipientUsername: to, messageBody: text, createdDate: at.toISOString() };
    messages.push(m);
    return m;
  };

  const server = createServer(async (req, res) => {
    const body = (await readBody(req)).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/identity/v1/oauth2/token") {
      const basic = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`;
      if (req.headers.authorization !== basic) return json(res, 401, { error: "invalid_client" });
      const form = new URLSearchParams(body);
      tokenRequests.push(form);
      if (form.get("grant_type") === "client_credentials") return json(res, 200, { access_token: `${accessToken}-app`, expires_in: 7200 });
      if (form.get("grant_type") === "authorization_code" && form.get("code") === opts.authCode) {
        return json(res, 200, { access_token: accessToken, expires_in: 7200, refresh_token: opts.refreshToken, refresh_token_expires_in: 47304000 });
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === opts.refreshToken) return json(res, 200, { access_token: accessToken, expires_in: 7200 });
      return json(res, 400, { error: "invalid_grant" });
    }
    const publicKey = /^\/commerce\/notification\/v1\/public_key\/([^/]+)$/.exec(url.pathname);
    if (publicKey) {
      if (req.headers.authorization !== `Bearer ${accessToken}-app`) return json(res, 401, { message: "application token required" });
      const key = opts.publicKeys?.[decodeURIComponent(publicKey[1]!)];
      return key ? json(res, 200, key) : json(res, 404, { message: "unknown key" });
    }
    if (req.headers.authorization !== `Bearer ${accessToken}`) return json(res, 401, { message: "invalid token" });
    if (url.pathname === "/commerce/identity/v1/user/") return json(res, 200, { userId: "u-1", username: opts.seller });
    const type = url.searchParams.get("conversation_type");
    if (req.method === "GET" && url.pathname === "/commerce/message/v1/conversation") {
      if (!type) return json(res, 400, { message: "conversation_type required" });
      const start = new Date(url.searchParams.get("start_time") ?? 0).getTime();
      const list = conversations
        .filter((c) => c.type === type && messages.some((m) => m.conversationId === c.conversationId && new Date(m.createdDate).getTime() >= start))
        .map((c) => ({ conversationId: c.conversationId, conversationTitle: c.conversationTitle, conversationType: c.type, referenceId: c.referenceId, referenceType: c.referenceId ? "LISTING" : undefined }));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      return json(res, 200, { conversations: list.slice(offset, offset + limit), total: list.length, offset, limit, ...(offset + limit < list.length ? { next: "next" } : {}) });
    }
    const conv = /^\/commerce\/message\/v1\/conversation\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && conv) {
      const id = decodeURIComponent(conv[1]!);
      const c = conversations.find((x) => x.conversationId === id);
      if (!c || c.type !== type) return json(res, 404, { message: "not found" });
      const list = messages.filter((m) => m.conversationId === id).map(({ conversationId: _c, ...m }) => m);
      return json(res, 200, { conversationTitle: c.conversationTitle, conversationType: c.type, messages: list, total: list.length });
    }
    if (req.method === "POST" && url.pathname === "/commerce/message/v1/send_message") {
      const parsed = JSON.parse(body) as { conversationId?: string; messageText?: string };
      const c = conversations.find((x) => x.conversationId === parsed.conversationId);
      if (!c || !parsed.messageText) return json(res, 400, { message: "invalid" });
      const buyer = messages.find((m) => m.conversationId === c.conversationId && m.senderUsername !== opts.seller)?.senderUsername ?? "buyer";
      return sendWithFault(fault, res, () => {
        sent.push({ conversationId: c.conversationId, messageText: parsed.messageText! });
        const m = addMessage(c.conversationId, opts.seller, buyer, parsed.messageText!);
        return { messageId: m.messageId, createdDate: m.createdDate, messageBody: m.messageBody };
      }, 200, opts.hangMs ?? 400);
    }
    return json(res, 404, { message: "unknown endpoint" });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    conversations,
    messages,
    sent,
    tokenRequests,
    requests,
    addConversation: (input) => {
      const at = input.at ?? new Date();
      conversations.push({ conversationId: input.id, conversationTitle: input.title, referenceId: input.referenceId, type: input.type ?? "FROM_MEMBERS", createdDate: at.toISOString() });
      return addMessage(input.id, input.buyer, opts.seller, input.text, at);
    },
    addMessage,
    setSendFault: (f) => (fault = f),
    close: () => close(server),
  };
}

// ---------------------------------------------------------------------------
// Mirakl inbox (M10/M11/M12)

export interface FakeMiraklThread {
  id: string;
  topic: { type: "FREE_TEXT"; value: string };
  entities: Array<{ id: string; type: string; label: string }>;
  current_participants: Array<{ id?: string; type: "CUSTOMER" | "OPERATOR" | "SHOP"; display_name: string }>;
  messages: Array<{ id: string; body: string; date_created: string; from: { type: string; display_name: string }; to: Array<{ type: string; display_name: string }>; attachments?: Array<{ id: string; name: string; size: number }> }>;
  date_updated: string;
}

export interface FakeMirakl {
  baseUrl: string;
  threads: FakeMiraklThread[];
  replies: Array<{ threadId: string; body: string; to: Array<{ type: string; id?: string }>; files: Array<{ name: string; type: string; size: number }> }>;
  requests: string[];
  addThread(input: { id: string; topic: string; orderId: string; customerId: string; customerName: string; text: string; from?: "CUSTOMER_USER" | "OPERATOR_USER"; at?: Date; files?: Array<{ id: string; name: string; data: Buffer }> }): void;
  setSendFault(fault: SendFault): void;
  close(): Promise<void>;
}

export async function startFakeMirakl(opts: { apiKey: string; hangMs?: number }): Promise<FakeMirakl> {
  const threads: FakeMiraklThread[] = [];
  const files = new Map<string, { name: string; data: Buffer }>();
  const replies: FakeMirakl["replies"] = [];
  const requests: string[] = [];
  let seq = 1;
  let fault: SendFault = "none";
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers.authorization !== opts.apiKey) return json(res, 401, { message: "Unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/inbox/threads") {
      const since = new Date(url.searchParams.get("updated_since") ?? 0).getTime();
      const withMessages = url.searchParams.get("with_messages") === "true";
      const data = threads.filter((t) => new Date(t.date_updated).getTime() >= since).map((t) => ({ ...t, messages: withMessages ? t.messages.slice(-100) : undefined }));
      return json(res, 200, { data });
    }
    const download = /^\/api\/inbox\/threads\/([^/]+)\/download$/.exec(url.pathname);
    if (req.method === "GET" && download) {
      const file = files.get(decodeURIComponent(download[1]!));
      if (!file) return json(res, 404, { message: "not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${file.name}"` });
      return void res.end(file.data);
    }
    const one = /^\/api\/inbox\/threads\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const t = threads.find((x) => x.id === decodeURIComponent(one[1]!));
      return t ? json(res, 200, t) : json(res, 404, { message: "not found" });
    }
    const reply = /^\/api\/inbox\/threads\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === "POST" && reply) {
      const t = threads.find((x) => x.id === decodeURIComponent(reply[1]!));
      if (!t) return json(res, 404, { message: "not found" });
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: raw }).formData();
      const part = form.get("message_input");
      const input = JSON.parse(typeof part === "string" ? part : await (part as Blob).text()) as { body: string; to: Array<{ type: string; id?: string }> };
      if (!input.body || !Array.isArray(input.to) || input.to.length === 0) return json(res, 400, { message: "invalid" });
      const files = form.getAll("files").map((f) => ({ name: (f as File).name, type: (f as File).type, size: (f as File).size }));
      return sendWithFault(fault, res, () => {
        replies.push({ threadId: t.id, body: input.body, to: input.to, files });
        const id = `msg-${seq++}`;
        t.messages.push({ id, body: input.body, date_created: new Date().toISOString(), from: { type: "SHOP_USER", display_name: "Shop" }, to: input.to.map((r) => ({ type: r.type, display_name: r.type })) });
        t.date_updated = new Date().toISOString();
        return { message_id: id, thread_id: t.id };
      }, 201, opts.hangMs ?? 400);
    }
    return json(res, 404, { message: "unknown endpoint" });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    threads,
    replies,
    requests,
    addThread: (input) => {
      for (const f of input.files ?? []) files.set(f.id, { name: f.name, data: f.data });
      const at = (input.at ?? new Date()).toISOString();
      threads.push({
        id: input.id,
        topic: { type: "FREE_TEXT", value: input.topic },
        entities: [{ id: input.orderId, type: "MMP_ORDER", label: input.orderId }],
        current_participants: [{ id: input.customerId, type: "CUSTOMER", display_name: input.customerName }, { type: "OPERATOR", display_name: "Operator" }, { id: "2001", type: "SHOP", display_name: "Shop" }],
        messages: [{ id: `msg-${seq++}`, body: input.text, date_created: at, from: { type: input.from ?? "CUSTOMER_USER", display_name: input.customerName }, to: [{ type: "SHOP", display_name: "Shop" }], ...(input.files?.length ? { attachments: input.files.map((f) => ({ id: f.id, name: f.name, size: f.data.length })) } : {}) }],
        date_updated: at,
      });
    },
    setSendFault: (f) => (fault = f),
    close: () => close(server),
  };
}

/** Signs a notification like eBay does (ECDSA, SHA1); returns the x-ebay-signature header and the matching public key. */
export function signEbayNotice(body: string, kid = "kid-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signature = sign("sha1", Buffer.from(body), privateKey).toString("base64");
  const header = Buffer.from(JSON.stringify({ alg: "ECDSA", kid, signature, digest: "SHA1" })).toString("base64");
  // eBay returns the PEM in one line; the verifier must cope with that.
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
  return { header, key: { algorithm: "ECDSA", digest: "SHA1", key: pem } };
}
