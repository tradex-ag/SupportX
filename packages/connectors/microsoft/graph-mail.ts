import type {
  AttachmentFile,
  AttachmentInfo,
  ConnectorCapabilities,
  ForwardRequest,
  IngressMessage,
  MessageAddress,
  MessageChannel,
  ReconcileOutcome,
  ReplyOutcome,
  ReplyRequest,
  SyncResult,
} from "../../core/contracts.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";

/**
 * Microsoft Graph mail adapter (application permissions, client credentials).
 *
 * Documentation reviewed 2026-10-21 (see docs/SOURCES.md, MS-1..MS-4):
 * - Delta per folder: GET /users/{id}/mailFolders/{id}/messages/delta with
 *   opaque @odata.nextLink/@odata.deltaLink; deleted items carry @removed;
 *   $filter only on receivedDateTime ge/gt for the initial round.
 * - Reply: POST /users/{id}/messages/{id}/reply, 202 Accepted, needs Mail.Send;
 *   the reply honours the original replyTo and is saved in Sent Items.
 * - Shared mailboxes for unattended access need application permissions; the
 *   Mail.Read.Shared delegated permissions do not support change notifications.
 * - Scope application access to the support mailboxes with Exchange Online
 *   RBAC for Applications. Unscoped Entra consent for Mail.Read/Mail.Send is
 *   additive and would grant access to every mailbox.
 *
 * Minimum permissions: Mail.Read (receive) and Mail.Send (reply, only once the
 * reply route is verified). Mail.ReadWrite is not required: drafts live in this
 * application's database, not in the mailbox.
 */
export interface GraphMailConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** User principal name or object id of the (shared) mailbox. */
  mailbox: string;
  /** Additional addresses that belong to this mailbox (aliases, send-as). */
  ownAddresses?: ReadonlyArray<string>;
  folders?: ReadonlyArray<string>;
  initialSyncDays?: number;
  maxPagesPerSync?: number;
  graphBaseUrl?: string;
  authorityHost?: string;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

export const OUTBOX_HEADER = "x-supportx-outbox-id";
const KEEP_HEADERS = new Set([
  "message-id",
  "in-reply-to",
  "references",
  "reply-to",
  "return-path",
  "authentication-results",
  "auto-submitted",
  "x-auto-response-suppress",
  // Bulk-mail markers, used to tell advertising from customer requests.
  "list-unsubscribe",
  "list-id",
  "precedence",
  "feedback-id",
  "x-campaign",
  "x-campaign-id",
  "x-mc-user",
  OUTBOX_HEADER,
]);
const SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "replyTo",
  "receivedDateTime",
  "sentDateTime",
  "hasAttachments",
  "body",
  "internetMessageHeaders",
].join(",");

function address(value: unknown): MessageAddress | null {
  const email = (value as { emailAddress?: { address?: string; name?: string } } | null)?.emailAddress;
  if (!email?.address) return null;
  return { address: email.address.toLowerCase(), name: email.name || undefined };
}

function addresses(value: unknown): MessageAddress[] {
  return Array.isArray(value) ? value.map(address).filter((a): a is MessageAddress => a !== null) : [];
}

function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:sans-serif">${escaped.replace(/\r?\n/g, "<br>")}</div>`;
}

export function mapGraphMessage(raw: Json, resource: string, ownAddresses: ReadonlyArray<string>): IngressMessage {
  const headers: Record<string, string> = {};
  for (const h of Array.isArray(raw.internetMessageHeaders) ? (raw.internetMessageHeaders as Array<{ name?: string; value?: string }>) : []) {
    const name = h.name?.toLowerCase();
    if (name && KEEP_HEADERS.has(name) && h.value !== undefined) headers[name] = h.value.slice(0, 2000);
  }
  const from = address(raw.from) ?? address(raw.sender) ?? { address: "unbekannt@invalid" };
  const own = ownAddresses.map((a) => a.toLowerCase());
  const outbound = resource.toLowerCase() === "sentitems" || own.includes(from.address);
  const body = raw.body as { content?: string; contentType?: string } | undefined;
  let bodyText = body?.content ?? "";
  if (body?.contentType?.toLowerCase() === "html") {
    // Fallback if the text preference was ignored: strip markup, never render HTML.
    bodyText = bodyText.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  const when = (outbound ? raw.sentDateTime : raw.receivedDateTime) ?? raw.receivedDateTime ?? raw.sentDateTime;
  return {
    externalMessageId: String(raw.id),
    internetMessageId: typeof raw.internetMessageId === "string" ? raw.internetMessageId : undefined,
    externalThreadKey: typeof raw.conversationId === "string" ? raw.conversationId : `message:${String(raw.id)}`,
    resource,
    direction: outbound ? "outbound" : "inbound",
    from,
    to: addresses(raw.toRecipients),
    replyTo: addresses(raw.replyTo),
    subject: typeof raw.subject === "string" ? raw.subject : "",
    bodyText: bodyText.slice(0, 200_000),
    receivedAt: new Date(typeof when === "string" ? when : Date.now()),
    headers,
    hasAttachments: raw.hasAttachments === true,
    aliasKeys: [],
  };
}

export class GraphMailChannel implements MessageChannel {
  readonly kind = "microsoft_graph";
  readonly capabilities: ConnectorCapabilities = {
    receive: "configured",
    reply: "configured",
    attachments: "documented",
    pushNotifications: "documented",
    sendReconciliation: "configured",
  };
  readonly ownAddresses: ReadonlyArray<string>;
  readonly #config: GraphMailConfig;
  readonly #graph: string;
  readonly #authority: string;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(config: GraphMailConfig) {
    this.#config = config;
    const allow = config.allowTestEndpoints ?? false;
    this.#graph = assertAllowedEndpoint(config.graphBaseUrl ?? "https://graph.microsoft.com/v1.0", allow, (u) => u.hostname === "graph.microsoft.com")
      .toString()
      .replace(/\/+$/, "");
    this.#authority = assertAllowedEndpoint(config.authorityHost ?? "https://login.microsoftonline.com", allow, (u) => u.hostname === "login.microsoftonline.com")
      .toString()
      .replace(/\/+$/, "");
    if (!/^[0-9a-f-]{36}$/i.test(config.tenantId) && !/^[a-z0-9.-]+$/i.test(config.tenantId)) throw new Error("Ungültige Tenant-ID.");
    this.ownAddresses = [config.mailbox, ...(config.ownAddresses ?? [])].map((a) => a.toLowerCase());
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const form = new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const doFetch = this.#config.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.#authority}/${encodeURIComponent(this.#config.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new HttpError(`Microsoft-Anmeldung nicht erreichbar: ${(error as Error).message}`, 0, true);
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !body.access_token) {
      const detail = body.error_description?.split("\r\n")[0] ?? body.error ?? `HTTP ${response.status}`;
      throw new HttpError(`Microsoft-Anmeldung fehlgeschlagen: ${detail}`, response.status, response.status >= 500);
    }
    this.#token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async #call(method: "GET" | "POST", url: string, body?: unknown, prefer?: string[]): Promise<Json | null> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (prefer && prefer.length > 0) headers.Prefer = prefer.join(", ");
    return (await requestJson(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.#config.timeoutMs ?? 20_000,
      fetchImpl: this.#config.fetchImpl,
    })) as Json | null;
  }

  /** File attachments of a message; inline parts (logos in templates) are left out. */
  async listAttachments(externalMessageId: string): Promise<AttachmentInfo[]> {
    const url = new URL(`${this.#mailboxPath()}/messages/${encodeURIComponent(externalMessageId)}/attachments`);
    url.searchParams.set("$select", "id,name,contentType,size,isInline");
    const body = await this.#call("GET", url.toString());
    const rows = Array.isArray(body?.value) ? (body!.value as Json[]) : [];
    return rows
      .filter((a) => a["@odata.type"] === undefined || a["@odata.type"] === "#microsoft.graph.fileAttachment")
      .filter((a) => a.isInline !== true)
      .map((a) => ({ id: String(a.id), name: typeof a.name === "string" ? a.name : "Anhang", contentType: typeof a.contentType === "string" ? a.contentType.toLowerCase() : "application/octet-stream", size: Number(a.size ?? 0) }));
  }

  async getAttachment(externalMessageId: string, _threadKey: string, attachmentId: string): Promise<AttachmentFile> {
    const body = await this.#call("GET", `${this.#mailboxPath()}/messages/${encodeURIComponent(externalMessageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (!body || typeof body.contentBytes !== "string") throw new HttpError("Anhang ohne Inhalt (kein Datei-Anhang).", 0, false);
    const data = Buffer.from(body.contentBytes, "base64");
    return { id: attachmentId, name: typeof body.name === "string" ? body.name : "Anhang", contentType: typeof body.contentType === "string" ? body.contentType.toLowerCase() : "application/octet-stream", size: data.length, data };
  }

  #mailboxPath(): string {
    return `${this.#graph}/users/${encodeURIComponent(this.#config.mailbox)}`;
  }

  #initialDeltaUrl(folder: string): string {
    const since = new Date(Date.now() - (this.#config.initialSyncDays ?? 14) * 86_400_000).toISOString();
    const url = new URL(`${this.#mailboxPath()}/mailFolders/${encodeURIComponent(folder)}/messages/delta`);
    url.searchParams.set("$select", "id,receivedDateTime");
    url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
    return url.toString();
  }

  #assertGraphUrl(url: string): void {
    // Cursors are opaque, but must point back to the configured Graph endpoint.
    if (!url.startsWith(`${this.#graph}/`)) throw new Error("Gespeicherter Synchronisationsstand verweist auf einen fremden Endpunkt.");
  }

  async #fetchMessage(id: string, resource: string): Promise<IngressMessage | null> {
    try {
      const raw = await this.#call(
        "GET",
        `${this.#mailboxPath()}/messages/${encodeURIComponent(id)}?$select=${SELECT}`,
        undefined,
        ['IdType="ImmutableId"', 'outlook.body-content-type="text"'],
      );
      return raw ? mapGraphMessage(raw, resource, this.ownAddresses) : null;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null; // deleted in between
      throw error;
    }
  }

  async sync(cursors: Readonly<Record<string, string>>): Promise<SyncResult> {
    const messages: IngressMessage[] = [];
    const removed: string[] = [];
    const next: Record<string, string> = {};
    let cursorReset = false;
    for (const folder of this.#config.folders ?? ["inbox", "sentitems"]) {
      let url = cursors[folder] ?? this.#initialDeltaUrl(folder);
      let pages = 0;
      while (pages < (this.#config.maxPagesPerSync ?? 20)) {
        this.#assertGraphUrl(url);
        let page: Json | null;
        try {
          page = await this.#call("GET", url, undefined, ['IdType="ImmutableId"', "odata.maxpagesize=50"]);
        } catch (error) {
          // An expired or invalid delta token: restart the round. Duplicates are
          // absorbed by the unique ingress keys.
          if (error instanceof HttpError && (error.status === 410 || /syncStateNotFound|resync/i.test(error.message)) && cursors[folder]) {
            cursorReset = true;
            url = this.#initialDeltaUrl(folder);
            continue;
          }
          throw error;
        }
        pages++;
        for (const item of Array.isArray(page?.value) ? (page.value as Json[]) : []) {
          if (item["@removed"]) {
            removed.push(String(item.id));
            continue;
          }
          const message = await this.#fetchMessage(String(item.id), folder);
          if (message) messages.push(message);
        }
        const nextLink = page?.["@odata.nextLink"];
        const deltaLink = page?.["@odata.deltaLink"];
        if (typeof nextLink === "string") {
          url = nextLink;
          next[folder] = nextLink; // resume an unfinished round next time
          continue;
        }
        if (typeof deltaLink === "string") next[folder] = deltaLink;
        break;
      }
    }
    return { messages, removedExternalIds: removed, cursors: next, cursorReset };
  }

  async sendReply(request: ReplyRequest): Promise<ReplyOutcome> {
    try {
      await this.#call("POST", `${this.#mailboxPath()}/messages/${encodeURIComponent(request.inReplyToExternalId)}/reply`, {
        message: {
          internetMessageHeaders: [{ name: OUTBOX_HEADER, value: request.outboxMarker }],
          // Small files go inline with the reply (Graph: up to about 3 MB per request).
          ...(request.attachments?.length ? { attachments: request.attachments.map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.contentType, contentBytes: a.data.toString("base64") })) } : {}),
        },
        comment: textToHtml(request.bodyText),
      });
      // 202 Accepted: Exchange accepted the request. Not a delivery receipt.
      return { state: "provider_accepted" };
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.uncertain) return { state: "uncertain", error: error.message };
        if (error.status === 403) {
          // Exchange RBAC for Applications grants reading and sending separately.
          return { state: "rejected", error: `Das Postfach ${this.#config.mailbox} darf über SupportX noch nicht senden: Microsoft lehnt ab (403). Der Microsoft-Admin muss der App das Senderecht geben (Exchange-Rolle „Application Mail.Send“ für dieses Postfach). Nach der Freigabe bis zu etwa einer Stunde warten, dann erneut senden. Es wurde nichts verschickt.`, retryable: false };
        }
        return { state: "rejected", error: error.message, retryable: error.retryable };
      }
      return { state: "uncertain", error: (error as Error).message };
    }
  }

  /**
   * Forward (MS-8): POST /messages/{id}/forward with message.toRecipients and a
   * comment, 202 Accepted, Mail.Send, saved to Sent Items. Text mode uses
   * POST /sendMail with a new message. The marker header lets reconcileReply and
   * ingestion recognise the sent copy. Not a delivery receipt.
   */
  async forwardMessage(request: ForwardRequest): Promise<ReplyOutcome> {
    const headers = [{ name: OUTBOX_HEADER, value: request.marker }];
    const toRecipients = request.to.map((address) => ({ emailAddress: { address } }));
    try {
      if (request.mode === "original") {
        await this.#call("POST", `${this.#mailboxPath()}/messages/${encodeURIComponent(request.externalMessageId)}/forward`, {
          message: { toRecipients, internetMessageHeaders: headers },
          comment: request.comment ? textToHtml(request.comment) : "",
        });
      } else {
        await this.#call("POST", `${this.#mailboxPath()}/sendMail`, {
          message: {
            subject: request.subject,
            body: { contentType: "HTML", content: textToHtml(request.bodyText) },
            toRecipients,
            internetMessageHeaders: headers,
            ...(request.attachments?.length ? { attachments: request.attachments.map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.contentType, contentBytes: a.data.toString("base64") })) } : {}),
          },
          saveToSentItems: true,
        });
      }
      return { state: "provider_accepted" };
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.uncertain) return { state: "uncertain", error: error.message };
        if (error.status === 403) {
          return { state: "rejected", error: `Das Postfach ${this.#config.mailbox} darf über SupportX noch nicht senden: Microsoft lehnt ab (403). Der Microsoft-Admin muss der App das Senderecht geben (Exchange-Rolle „Application Mail.Send“ für dieses Postfach). Es wurde nichts weitergeleitet.`, retryable: false };
        }
        return { state: "rejected", error: error.message, retryable: error.retryable };
      }
      return { state: "uncertain", error: (error as Error).message };
    }
  }

  async reconcileReply(marker: string, since: Date, threadKey: string, _sentBody?: string): Promise<ReconcileOutcome> {
    try {
      const url = new URL(`${this.#mailboxPath()}/mailFolders/sentitems/messages`);
      url.searchParams.set("$filter", `sentDateTime ge ${new Date(since.getTime() - 5 * 60_000).toISOString()}`);
      url.searchParams.set("$select", "id,internetMessageId,conversationId,internetMessageHeaders,sentDateTime");
      url.searchParams.set("$top", "50");
      const page = await this.#call("GET", url.toString(), undefined, ['IdType="ImmutableId"']);
      for (const item of Array.isArray(page?.value) ? (page.value as Json[]) : []) {
        const headers = Array.isArray(item.internetMessageHeaders) ? (item.internetMessageHeaders as Array<{ name?: string; value?: string }>) : [];
        const hit = headers.some((h) => h.name?.toLowerCase() === OUTBOX_HEADER && h.value === marker);
        // The marker is unique per send; the reply can sit in a later thread joined to the case.
        if (hit) {
          return { state: "found", externalMessageId: String(item.id), internetMessageId: typeof item.internetMessageId === "string" ? item.internetMessageId : undefined };
        }
      }
      return { state: "not_found" };
    } catch (error) {
      return { state: "unknown", error: (error as Error).message };
    }
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      const inbox = await this.#call("GET", `${this.#mailboxPath()}/mailFolders/inbox?$select=id,displayName,totalItemCount`);
      return { ok: true, detail: `Posteingang lesbar (${String(inbox?.totalItemCount ?? "?")} Nachrichten).` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  /** Create or renew a change-notification subscription for the inbox (optional push trigger). */
  async upsertSubscription(input: { existingId?: string; notificationUrl: string; clientState: string; minutes: number }): Promise<{ id: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + input.minutes * 60_000).toISOString();
    if (input.existingId) {
      try {
        const token = await this.#accessToken();
        await requestJson(`${this.#graph}/subscriptions/${encodeURIComponent(input.existingId)}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ expirationDateTime: expiresAt }),
          timeoutMs: this.#config.timeoutMs ?? 20_000,
          fetchImpl: this.#config.fetchImpl,
        });
        return { id: input.existingId, expiresAt };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    const created = await this.#call("POST", `${this.#graph}/subscriptions`, {
      changeType: "created",
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.notificationUrl,
      resource: `users/${this.#config.mailbox}/mailFolders('inbox')/messages`,
      expirationDateTime: expiresAt,
      clientState: input.clientState,
    });
    return { id: String(created?.id), expiresAt };
  }
}
