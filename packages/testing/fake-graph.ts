import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the parts of Microsoft Graph the mail adapter uses:
 * client-credentials token, folder delta with paging, single message GET,
 * reply (saved to Sent Items, keeps x- headers), Sent Items listing.
 * Fault injection covers timeouts before/after a reply was executed, 5xx,
 * 4xx and expired delta tokens. Synthetic data only; no real Graph behaviour
 * is claimed beyond what docs/SOURCES.md documents.
 */
export interface FakeMail {
  id: string;
  folder: "inbox" | "sentitems";
  seq: number;
  internetMessageId: string;
  conversationId: string;
  subject: string;
  from: { address: string; name?: string };
  to: Array<{ address: string; name?: string }>;
  replyTo: Array<{ address: string; name?: string }>;
  body: string;
  receivedDateTime: string;
  headers: Array<{ name: string; value: string }>;
  attachments?: Array<{ id: string; name: string; contentType: string; contentBytes: string; isInline?: boolean }>;
}

export type ReplyFault = "none" | "timeout_after_send" | "timeout_before_send" | "server_error_after_send" | "reject_400" | "reject_403" | "throttle_429";

export interface FakeGraph {
  graphBaseUrl: string;
  authorityHost: string;
  mailbox: string;
  messages: FakeMail[];
  replies: Array<{ inReplyTo: string; comment: string; headers: Array<{ name: string; value: string }>; attachments: Array<{ name: string; contentType: string; contentBytes: string }> }>;
  /** Forwards (POST /messages/{id}/forward) and new mails (POST /sendMail). */
  forwards: Array<{ kind: "forward" | "sendMail"; original?: string; to: string[]; subject: string; body: string; headers: Array<{ name: string; value: string }>; attachments: Array<{ name: string; contentType: string; contentBytes: string }> }>;
  addInbound(input: { from: string; fromName?: string; subject: string; body: string; conversationId?: string; replyTo?: string; receivedAt?: Date; internetMessageId?: string; id?: string; attachments?: FakeMail["attachments"] }): FakeMail;
  addSent(input: { to: string; subject: string; body: string; conversationId: string; headers?: Array<{ name: string; value: string }> }): FakeMail;
  setReplyFault(fault: ReplyFault): void;
  /** Keep sent copies from carrying our marker header (tests the no-header path). */
  setStripCustomHeaders(strip: boolean): void;
  expireDeltaTokens(): void;
  requests: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeGraph(opts: { mailbox: string; clientSecret: string; pageSize?: number; port?: number; hangMs?: number }): Promise<FakeGraph> {
  const messages: FakeMail[] = [];
  const replies: FakeGraph["replies"] = [];
  const forwards: FakeGraph["forwards"] = [];
  const requests: string[] = [];
  let seq = 0;
  let epoch = 1;
  let fault: ReplyFault = "none";
  let stripHeaders = false;
  let base = "";

  const addSent: FakeGraph["addSent"] = (input) => {
    const mail: FakeMail = {
      id: `AAMk-sent-${randomUUID()}`,
      folder: "sentitems",
      seq: ++seq,
      internetMessageId: `<${randomUUID()}@fake-graph.invalid>`,
      conversationId: input.conversationId,
      subject: input.subject,
      from: { address: opts.mailbox },
      to: [{ address: input.to }],
      replyTo: [],
      body: input.body,
      receivedDateTime: new Date().toISOString(),
      headers: stripHeaders ? [] : input.headers ?? [],
    };
    messages.push(mail);
    return mail;
  };

  const addInbound: FakeGraph["addInbound"] = (input) => {
    const mail: FakeMail = {
      id: input.id ?? `AAMk-in-${randomUUID()}`,
      folder: "inbox",
      seq: ++seq,
      internetMessageId: input.internetMessageId ?? `<${randomUUID()}@customer.invalid>`,
      conversationId: input.conversationId ?? `conv-${randomUUID()}`,
      subject: input.subject,
      from: { address: input.from, name: input.fromName },
      to: [{ address: opts.mailbox }],
      replyTo: input.replyTo ? [{ address: input.replyTo }] : [],
      body: input.body,
      receivedDateTime: (input.receivedAt ?? new Date()).toISOString(),
      headers: [],
      attachments: input.attachments,
    };
    messages.push(mail);
    return mail;
  };

  const toGraph = (m: FakeMail) => ({
    id: m.id,
    internetMessageId: m.internetMessageId,
    conversationId: m.conversationId,
    subject: m.subject,
    from: { emailAddress: m.from },
    sender: { emailAddress: m.from },
    toRecipients: m.to.map((t) => ({ emailAddress: t })),
    replyTo: m.replyTo.map((t) => ({ emailAddress: t })),
    receivedDateTime: m.receivedDateTime,
    sentDateTime: m.receivedDateTime,
    hasAttachments: (m.attachments?.length ?? 0) > 0,
    body: { contentType: "text", content: m.body },
    internetMessageHeaders: [{ name: "Message-ID", value: m.internetMessageId }, ...m.headers],
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const raw = await readBody(req);

    if (req.method === "POST" && /^\/login\/[^/]+\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      const form = new URLSearchParams(raw);
      if (form.get("client_secret") !== opts.clientSecret) return send(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
      return send(200, { access_token: "fake-token", expires_in: 3600, token_type: "Bearer" });
    }
    if (req.method === "POST" && url.pathname === "/demo/inbound") {
      // Test hook (not part of Graph): inject a synthetic customer mail.
      const input = JSON.parse(raw || "{}") as { from?: string; subject?: string; body?: string; conversationId?: string; replyTo?: string };
      if (!input.from || !input.subject || !input.body) return send(400, { error: "from, subject, body required" });
      const mail = addInbound({ from: input.from, subject: input.subject, body: input.body, conversationId: input.conversationId, replyTo: input.replyTo });
      return send(201, { id: mail.id, conversationId: mail.conversationId });
    }
    if (url.pathname.startsWith("/graph/") && req.headers.authorization !== "Bearer fake-token") return send(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });

    const mailboxPrefix = `/graph/v1.0/users/${encodeURIComponent(opts.mailbox)}`;
    if (!url.pathname.startsWith(mailboxPrefix)) return send(404, { error: { code: "ErrorInvalidUser", message: "The requested user is invalid." } });
    const rest = url.pathname.slice(mailboxPrefix.length);

    const delta = /^\/mailFolders\/(inbox|sentitems)\/messages\/delta$/.exec(rest);
    if (req.method === "GET" && delta) {
      const folder = delta[1] as FakeMail["folder"];
      const token = url.searchParams.get("$deltatoken") ?? url.searchParams.get("$skiptoken");
      let after = 0;
      if (token) {
        const [tokenEpoch, value] = token.split(".");
        if (Number(tokenEpoch) !== epoch) return send(410, { error: { code: "SyncStateNotFound", message: "The sync state generation is not found." } });
        after = Number(value);
      }
      const all = messages.filter((m) => m.folder === folder && m.seq > after).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, opts.pageSize ?? 50);
      const last = page.length ? page[page.length - 1]!.seq : after;
      const body: Record<string, unknown> = { value: page.map((m) => ({ id: m.id, receivedDateTime: m.receivedDateTime })) };
      const link = `${base}${mailboxPrefix}/mailFolders/${folder}/messages/delta`;
      if (all.length > page.length) body["@odata.nextLink"] = `${link}?$skiptoken=${epoch}.${last}`;
      else body["@odata.deltaLink"] = `${link}?$deltatoken=${epoch}.${Math.max(last, after)}`;
      return send(200, body);
    }

    const single = /^\/messages\/([^/]+)$/.exec(rest);
    if (req.method === "GET" && single) {
      const mail = messages.find((m) => m.id === decodeURIComponent(single[1]!));
      return mail ? send(200, toGraph(mail)) : send(404, { error: { code: "ErrorItemNotFound", message: "Not found" } });
    }

    const files = /^\/messages\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(rest);
    if (req.method === "GET" && files) {
      const mail = messages.find((m) => m.id === decodeURIComponent(files[1]!));
      if (!mail) return send(404, { error: { code: "ErrorItemNotFound", message: "Not found" } });
      const all = (mail.attachments ?? []).map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", id: a.id, name: a.name, contentType: a.contentType, size: Buffer.from(a.contentBytes, "base64").length, isInline: a.isInline ?? false, contentBytes: a.contentBytes }));
      if (!files[2]) return send(200, { value: all.map(({ contentBytes: _c, ...meta }) => meta) });
      const one = all.find((a) => a.id === decodeURIComponent(files[2]!));
      return one ? send(200, one) : send(404, { error: { code: "ErrorItemNotFound", message: "Not found" } });
    }

    const reply = /^\/messages\/([^/]+)\/reply$/.exec(rest);
    if (req.method === "POST" && reply) {
      const original = messages.find((m) => m.id === decodeURIComponent(reply[1]!));
      if (!original) return send(404, { error: { code: "ErrorItemNotFound", message: "Not found" } });
      const payload = JSON.parse(raw || "{}") as { comment?: string; message?: { internetMessageHeaders?: Array<{ name: string; value: string }>; attachments?: Array<{ name: string; contentType: string; contentBytes: string }> } };
      const current = fault;
      fault = "none";
      if (current === "reject_400") return send(400, { error: { code: "ErrorInvalidRecipients", message: "Simulated rejection." } });
      if (current === "reject_403") return send(403, { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } });
      if (current === "throttle_429") return send(429, { error: { code: "ApplicationThrottled", message: "Simulated throttling." } });
      if (current === "timeout_before_send") return void setTimeout(() => send(504), opts.hangMs ?? 3000);
      const recipient = original.replyTo[0]?.address ?? original.from.address;
      replies.push({ inReplyTo: original.id, comment: payload.comment ?? "", headers: payload.message?.internetMessageHeaders ?? [], attachments: payload.message?.attachments ?? [] });
      addSent({ to: recipient, subject: `AW: ${original.subject}`, body: payload.comment ?? "", conversationId: original.conversationId, headers: payload.message?.internetMessageHeaders });
      if (current === "timeout_after_send") return void setTimeout(() => send(202), opts.hangMs ?? 3000);
      if (current === "server_error_after_send") return send(503, { error: { code: "ServiceUnavailable", message: "Simulated." } });
      return send(202);
    }

    const forward = /^\/messages\/([^/]+)\/forward$/.exec(rest);
    if (req.method === "POST" && (forward || rest === "/sendMail")) {
      type Rcpt = Array<{ emailAddress?: { address?: string } }>;
      const payload = JSON.parse(raw || "{}") as { comment?: string; toRecipients?: Rcpt; message?: { subject?: string; body?: { content?: string }; toRecipients?: Rcpt; internetMessageHeaders?: Array<{ name: string; value: string }>; attachments?: Array<{ name: string; contentType: string; contentBytes: string }> } };
      const original = forward ? messages.find((m) => m.id === decodeURIComponent(forward[1]!)) : undefined;
      if (forward && !original) return send(404, { error: { code: "ErrorItemNotFound", message: "Not found" } });
      // Documented constraints (MS-8): toRecipients either top level or in message, comment or message.body.
      if (forward && (!!payload.toRecipients === !!payload.message?.toRecipients)) return send(400, { error: { code: "ErrorInvalidRequest", message: "Specify toRecipients either top level or in message." } });
      if (forward && payload.comment !== undefined && payload.message?.body) return send(400, { error: { code: "ErrorInvalidRequest", message: "comment and message.body." } });
      const to = (payload.toRecipients ?? payload.message?.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean);
      if (to.length === 0) return send(400, { error: { code: "ErrorInvalidRecipients", message: "At least one recipient is required." } });
      const current = fault;
      fault = "none";
      if (current === "reject_400") return send(400, { error: { code: "ErrorInvalidRecipients", message: "Simulated rejection." } });
      if (current === "reject_403") return send(403, { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } });
      if (current === "throttle_429") return send(429, { error: { code: "ApplicationThrottled", message: "Simulated throttling." } });
      if (current === "timeout_before_send") return void setTimeout(() => send(504), opts.hangMs ?? 3000);
      const subject = original ? `WG: ${original.subject}` : payload.message?.subject ?? "";
      const body = original ? `${payload.comment ?? ""}\n\n${original.body}` : payload.message?.body?.content ?? "";
      const headers = payload.message?.internetMessageHeaders ?? [];
      forwards.push({ kind: original ? "forward" : "sendMail", original: original?.id, to, subject, body, headers, attachments: original ? (original.attachments ?? []).filter((a) => !a.isInline) : payload.message?.attachments ?? [] });
      addSent({ to: to[0]!, subject, body, conversationId: original?.conversationId ?? `conv-${randomUUID()}`, headers });
      if (current === "timeout_after_send") return void setTimeout(() => send(202), opts.hangMs ?? 3000);
      if (current === "server_error_after_send") return send(503, { error: { code: "ServiceUnavailable", message: "Simulated." } });
      return send(202);
    }

    if (req.method === "GET" && rest === "/mailFolders/sentitems/messages") {
      return send(200, { value: messages.filter((m) => m.folder === "sentitems").map(toGraph) });
    }
    if (req.method === "GET" && rest === "/mailFolders/inbox") {
      return send(200, { id: "inbox", displayName: "Posteingang", totalItemCount: messages.filter((m) => m.folder === "inbox").length });
    }
    return send(404, { error: { code: "NotImplementedInFake", message: rest } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  return {
    graphBaseUrl: `${base}/graph/v1.0`,
    authorityHost: `${base}/login`,
    mailbox: opts.mailbox,
    messages,
    replies,
    forwards,
    requests,
    addInbound,
    addSent,
    setReplyFault: (f) => {
      fault = f;
    },
    setStripCustomHeaders: (s) => {
      stripHeaders = s;
    },
    expireDeltaTokens: () => {
      epoch++;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
