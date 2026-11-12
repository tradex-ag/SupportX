import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { one } from "../../packages/storage/db.ts";
import { DEFAULT_THEME, parseTheme, publicTheme, themeCss, type Theme } from "../../packages/core/theme.ts";
import { actorFor, changePassword, login, logout, userForSession, workspacesFor } from "../../packages/services/auth.ts";
import { deleteSnippet, listSnippets, saveSnippet } from "../../packages/services/snippets.ts";
import { setAutomation, setCaseTopic } from "../../packages/services/automation.ts";
import { addNote, assign, caseCounts, checkWorkspaceAiKey, deleteCategoryRule, exportCasesCsv, getCase, getSettings, leavePresence, listCases, setCaseCategory, previewSubjectPattern, touchPresence, setOutcome, setStatus, setSetupConfirmation, setWorkspaceAiKey, updateWorkspaceSettings, type CaseFilter } from "../../packages/services/cases.ts";
import {
  addRoutingRule,
  checkChannel,
  checkErp,
  completeEbayConsent,
  createEbayConnection,
  createGraphConnection,
  createKauflandConnection,
  createMerchantAccount,
  createMiraklConnection,
  deleteRoutingRule,
  revokeReplyRoute,
  setConnectionPaused, replaceConnectionSecret, deleteConnection,
  setMiraklBackgroundSync,
  setPlatformSending,
  setSendEnabled,
  startEbayConsent,
  upsertWeclappConnection,
  verifyReplyRoute,
  type GraphConnectionSettings,
} from "../../packages/services/connections.ts";
import { EBAY_DELETION_PATH, ebayChallengeResponse } from "../../packages/connectors/ebay/account-deletion.ts";
import { handleEbayAccountDeletion } from "../../packages/services/ebay-account-deletion.ts";
import { ServiceError, type Actor, type AppContext } from "../../packages/services/context.ts";
import { enqueue } from "../../packages/services/jobs.ts";
import { linkOrderManually, refreshOrderLink, setConversationAccount } from "../../packages/services/matching.ts";
import { getMessageAttachment, listMessageAttachments } from "../../packages/services/attachments.ts";
import { forwardMessage, getForwardInfo, resolveForward } from "../../packages/services/forwards.ts";
import { attachUploadedFile, deleteDocument, getDocument, listDocuments, setDraftDocuments, uploadDocument } from "../../packages/services/documents.ts";
import { draftInvoiceReply, fetchCaseInvoices } from "../../packages/services/invoices.ts";
import { deleteLogo, getLogo, logoVersion, previewDesign, resetDesign, saveDesign, saveLogo, workspaceTheme } from "../../packages/services/design.ts";
import { writeDesignMd, type WorkspaceTheme } from "../../packages/core/design-md.ts";
import { checkAmazonListingConnection, closeAmazonOffer, deleteAmazonListingConnection, getAmazonListingSettings, lookupAmazonListing, saveAmazonListingConnection } from "../../packages/services/amazon-listings.ts";
import { batchCandidates, sendMany } from "../../packages/services/batch.ts";
import { supportReport } from "../../packages/services/reports.ts";
import { addToRefundList, listRefunds, removeFromRefundList, setRefundDetails, setRefundDone } from "../../packages/services/refunds.ts";
import { evidencePdf } from "../../packages/services/evidence.ts";
import { composeDraft, discardDraft, editDraft, polishDraft, renderSnippet, requestRedraft, resolveUncertainSend, sendDraft, snippetDraft } from "../../packages/services/replies.ts";

const SESSION_COOKIE = "supportx_session";
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError(400, "INVALID", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}

export async function buildServer(ctx: AppContext, opts: { logger?: boolean; ebayFetch?: typeof fetch } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  await app.register(cookie);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ServiceError) return reply.status(error.status).send({ error: error.code, message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "BAD_REQUEST", message: (error as Error).message });
    app.log.error(error);
    return reply.status(500).send({ error: "INTERNAL", message: "Interner Fehler." });
  });

  // Session authentication plus a custom header on state-changing calls (CSRF):
  // browsers cannot send it cross-site without a CORS preflight, which we never allow.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/login") || req.url.startsWith("/api/health") || req.url === "/api/theme") return;
    if (req.method !== "GET" && req.headers["x-supportx-request"] !== "1") {
      return reply.status(403).send({ error: "CSRF", message: "Anfrage abgelehnt." });
    }
    const user = await userForSession(ctx.db, req.cookies[SESSION_COOKIE]);
    if (!user) return reply.status(401).send({ error: "UNAUTHENTICATED", message: "Bitte anmelden." });
    req.userId = user.id;
  });

  const actor = (req: FastifyRequest): Promise<Actor> => actorFor(ctx.db, req.userId!, (req.params as { ws: string }).ws);

  // --- Look of this installation (public: the login page needs it too) --------
  const theme = loadTheme(ctx.config.THEME_DIR, (line) => app.log.warn(line));
  const css = themeCss(theme);
  app.get("/theme.css", async (_req, reply) => reply.type("text/css; charset=utf-8").header("Cache-Control", "no-cache").send(css));
  app.get("/api/theme", async () => publicTheme(theme));
  // Workspace look from an uploaded DESIGN.md, layered over the installation theme.
  const mergeTheme = (own: WorkspaceTheme): Theme => parseTheme({ ...theme, productName: own.productName ?? theme.productName, colors: { ...theme.colors, ...own.colors }, fonts: { ...theme.fonts, ...own.fonts }, radius: own.radius ?? theme.radius });
  app.get("/api/w/:ws/theme", async (req) => {
    const who = await actor(req);
    const [own, logo] = await Promise.all([workspaceTheme(ctx, who), logoVersion(ctx, who)]);
    const logoUrl = logo ? `/api/w/${who.workspaceId}/logo?v=${logo}` : null;
    if (!own) return { custom: null, css: "", productName: theme.productName, logoUrl };
    const merged = mergeTheme(own);
    return { custom: own, css: themeCss(merged), productName: merged.productName, logoUrl };
  });
  app.post("/api/w/:ws/design/preview", async (req) => {
    const body = parse(z.object({ text: z.string().max(400_000) }), req.body);
    const reading = previewDesign(await actor(req), body.text);
    // CSS of the whole look, so the page can show it before anything is saved.
    return { ...reading, css: themeCss(mergeTheme(reading.theme)) };
  });
  app.put("/api/w/:ws/design", async (req) => saveDesign(ctx, await actor(req), req.body));
  app.delete("/api/w/:ws/design", async (req) => {
    await resetDesign(ctx, await actor(req));
    return { ok: true };
  });
  // Current look (or the standard look as template) as DESIGN.md, to edit and upload again.
  app.get("/api/w/:ws/design.md", async (req, reply) => {
    const own = await workspaceTheme(ctx, await actor(req));
    const t = own ? mergeTheme(own) : theme;
    const { soft: _soft, ...colors } = t.colors;
    const text = writeDesignMd({ productName: t.productName, colors, fonts: { sans: t.fonts.sans, mono: t.fonts.mono }, radius: t.radius }, { custom: Boolean(own) });
    return reply.type("text/markdown; charset=utf-8").header("Content-Disposition", `attachment; filename="${own ? "DESIGN" : "DESIGN-Vorlage"}.md"`).header("Cache-Control", "no-store").send(text);
  });
  app.put("/api/w/:ws/logo", { bodyLimit: 500_000 }, async (req) => {
    const body = parse(z.object({ base64: z.string().max(450_000) }), req.body);
    return saveLogo(ctx, await actor(req), body.base64);
  });
  app.delete("/api/w/:ws/logo", async (req) => {
    await deleteLogo(ctx, await actor(req));
    return { ok: true };
  });
  app.get("/api/w/:ws/logo", async (req, reply) => {
    const logo = await getLogo(ctx, await actor(req));
    if (!logo) return reply.status(404).send({ error: "NOT_FOUND", message: "Kein Logo hinterlegt." });
    return reply.type(logo.type).header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'").header("Cache-Control", "private, max-age=86400").send(logo.bytes);
  });
  if (ctx.config.THEME_DIR && existsSync(ctx.config.THEME_DIR)) {
    await app.register(fastifyStatic, { root: path.resolve(ctx.config.THEME_DIR), prefix: "/theme/", decorateReply: false, index: false, allowedPath: (p) => /^\/[\w.-]+\.(svg|png|jpe?g|webp|woff2?|ttf|otf)$/i.test(p) });
  }

  app.get("/api/health", async () => {
    await ctx.db.query("SELECT 1");
    return { ok: true, sendMode: ctx.config.SEND_MODE, demoMode: ctx.config.DEMO_MODE };
  });

  app.post("/api/login", async (req, reply) => {
    if (req.headers["x-supportx-request"] !== "1") return reply.status(403).send({ error: "CSRF", message: "Anfrage abgelehnt." });
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const session = await login(ctx.db, body.email, body.password);
    reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "strict", secure: ctx.config.SECURE_COOKIES, path: "/", maxAge: 7 * 86400 });
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await logout(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/password", async (req) => {
    const body = parse(z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(1).max(200) }), req.body);
    await changePassword(ctx.db, req.userId!, req.cookies[SESSION_COOKIE] ?? "", body.oldPassword, body.newPassword);
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const user = await one<{ id: string; email: string; display_name: string }>(ctx.db, "SELECT id, email, display_name FROM users WHERE id = $1", [req.userId]);
    return { user, workspaces: await workspacesFor(ctx.db, req.userId!), demoMode: ctx.config.DEMO_MODE, sendMode: ctx.config.SEND_MODE };
  });

  // --- Cases -----------------------------------------------------------------
  app.get("/api/w/:ws/cases", async (req) => {
    const filter = parse(z.enum(["open", "needs_attention", "waiting", "closed", "info", "all"]).default("open"), (req.query as { filter?: string }).filter) as CaseFilter;
    const q = parse(z.string().max(100).optional(), (req.query as { q?: string }).q);
    const topic = parse(z.string().max(40).optional(), (req.query as { topic?: string }).topic);
    const a = await actor(req);
    return { cases: await listCases(ctx, a, filter, q, topic), counts: await caseCounts(ctx, a) };
  });
  app.post("/api/w/:ws/cases/:id/category", async (req) => {
    const body = parse(z.object({ category: z.enum(["support", "info"]), remember: z.enum(["none", "address", "domain", "subject"]).optional(), pattern: z.string().max(300).optional() }), req.body);
    const { moved } = await setCaseCategory(ctx, await actor(req), (req.params as { id: string }).id, body);
    return { ok: true, moved };
  });
  app.post("/api/w/:ws/category-rules/preview", async (req) => {
    const body = parse(z.object({ category: z.enum(["support", "info"]), pattern: z.string().max(300) }), req.body);
    return previewSubjectPattern(ctx, await actor(req), body);
  });
  app.delete("/api/w/:ws/category-rules/:id", async (req) => {
    await deleteCategoryRule(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get("/api/w/:ws/cases/:id", async (req) => getCase(ctx, await actor(req), (req.params as { id: string }).id));
  app.get("/api/w/:ws/messages/:id/attachments", async (req) => ({ attachments: await listMessageAttachments(ctx, await actor(req), (req.params as { id: string }).id) }));
  app.get("/api/w/:ws/messages/:id/attachments/:attachmentId", async (req, reply) => {
    const p = req.params as { id: string; attachmentId: string };
    const file = await getMessageAttachment(ctx, await actor(req), p.id, p.attachmentId);
    const name = file.name.replace(/[^\w.\- äöüÄÖÜß]/g, "_").slice(0, 120) || "anhang";
    // Customer files are untrusted: images shown as images, everything else only as a download, never rendered.
    return reply
      .type(file.inline ? file.contentType : "application/octet-stream")
      .header("Content-Disposition", `${file.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=300")
      .send(file.data);
  });
  app.get("/api/w/:ws/messages/:id/forward", async (req) => getForwardInfo(ctx, await actor(req), (req.params as { id: string }).id));
  app.post("/api/w/:ws/messages/:id/forward", async (req) => {
    const body = parse(z.object({ forwardId: z.string().uuid(), to: z.union([z.string().max(3000), z.array(z.string().max(320)).max(20)]), comment: z.string().max(5000).optional() }), req.body);
    return forwardMessage(ctx, await actor(req), (req.params as { id: string }).id, body);
  });
  app.post("/api/w/:ws/forwards/:id/resolve", async (req) => {
    const body = parse(z.object({ action: z.enum(["check", "was_sent", "was_not_sent"]) }), req.body);
    return resolveForward(ctx, await actor(req), (req.params as { id: string }).id, body.action);
  });
  app.post("/api/w/:ws/cases/:id/notes", async (req) => {
    await addNote(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ body: z.string() }), req.body).body);
    return { ok: true };
  });
  app.post("/api/w/:ws/cases/:id/status", async (req) => {
    const body = parse(z.object({ status: z.string(), snoozeUntil: z.string().max(40).nullable().optional() }), req.body);
    await setStatus(ctx, await actor(req), (req.params as { id: string }).id, body.status, body.snoozeUntil);
    return { ok: true };
  });
  app.post("/api/w/:ws/cases/:id/topic", async (req) => {
    await setCaseTopic(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ topic: z.string().max(40).nullable() }), req.body).topic);
    return { ok: true };
  });
  app.post("/api/w/:ws/automations", async (req) => {
    await setAutomation(ctx, await actor(req), parse(z.object({ topic: z.string().max(40), mode: z.string().max(10) }), req.body));
    return { ok: true };
  });
  app.post("/api/w/:ws/cases/:id/presence", async (req) => {
    const body = parse(z.object({ editing: z.boolean().default(false) }), req.body ?? {});
    return { others: await touchPresence(ctx, await actor(req), (req.params as { id: string }).id, body.editing) };
  });
  app.delete("/api/w/:ws/cases/:id/presence", async (req) => {
    await leavePresence(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get("/api/w/:ws/snippets", async (req) => ({ snippets: await listSnippets(ctx, await actor(req)) }));
  app.post("/api/w/:ws/snippets", async (req) => {
    const body = parse(z.object({ id: z.string().optional(), title: z.string().max(200), body: z.string().max(12_000) }), req.body);
    return { snippet: await saveSnippet(ctx, await actor(req), body) };
  });
  app.delete("/api/w/:ws/snippets/:id", async (req) => {
    await deleteSnippet(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get("/api/w/:ws/cases/:id/snippets/:snippetId", async (req) => {
    const p = req.params as { id: string; snippetId: string };
    return renderSnippet(ctx, await actor(req), p.id, p.snippetId);
  });
  app.post("/api/w/:ws/cases/:id/snippet-reply", async (req) => {
    const body = parse(z.object({ snippetId: z.string() }), req.body);
    return snippetDraft(ctx, await actor(req), (req.params as { id: string }).id, body.snippetId);
  });
  app.post("/api/w/:ws/cases/:id/outcome", async (req) => {
    const body = parse(z.object({ outcome: z.string().nullable(), note: z.string().max(2000).optional() }), req.body);
    await setOutcome(ctx, await actor(req), (req.params as { id: string }).id, body);
    return { ok: true };
  });
  app.get("/api/w/:ws/export/cases.csv", async (req, reply) => {
    const csv = await exportCasesCsv(ctx, await actor(req));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="supportx-faelle-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("cache-control", "no-store")
      .send(csv);
  });
  app.post("/api/w/:ws/cases/:id/assign", async (req) => {
    await assign(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ userId: z.string().uuid().nullable() }), req.body).userId);
    return { ok: true };
  });
  app.post("/api/w/:ws/cases/:id/merchant-account", async (req) => {
    await setConversationAccount(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ merchantAccountId: z.string().uuid() }), req.body).merchantAccountId);
    return { ok: true };
  });
  app.post("/api/w/:ws/cases/:id/order-link", async (req) => {
    const body = parse(z.object({ reference: z.string().max(60).optional(), candidateId: z.string().max(60).optional() }), req.body);
    return { status: await linkOrderManually(ctx, await actor(req), (req.params as { id: string }).id, body) };
  });
  // Read the linked order again from weclapp (GET only), e.g. to see a return created later.
  app.post("/api/w/:ws/cases/:id/order-refresh", async (req) => refreshOrderLink(ctx, await actor(req), (req.params as { id: string }).id));
  // Amazon offer from the case: read first (changes nothing), then close only with the dialog's confirmation.
  const listingTarget = { sku: z.string().min(1).max(200), marketplaceId: z.string().min(5).max(20) };
  app.post("/api/w/:ws/cases/:id/amazon-listing/lookup", async (req) => {
    const body = parse(z.object(listingTarget), req.body);
    return lookupAmazonListing(ctx, await actor(req), (req.params as { id: string }).id, body);
  });
  app.post("/api/w/:ws/cases/:id/amazon-listing/close", async (req) => {
    const body = parse(z.object({ ...listingTarget, confirm: z.literal(true), expectedAsin: z.string().max(20).optional() }), req.body);
    return closeAmazonOffer(ctx, await actor(req), (req.params as { id: string }).id, body);
  });
  app.post("/api/w/:ws/cases/:id/redraft", async (req) => {
    const body = parse(z.object({ decision: z.enum(["customer_right", "customer_wrong", "ask_customer"]) }), req.body);
    await requestRedraft(ctx, await actor(req), (req.params as { id: string }).id, body.decision);
    return { ok: true };
  });

  // --- Drafts, approvals, outbox -------------------------------------------------
  app.put("/api/w/:ws/drafts/:id", async (req) => {
    const body = parse(z.object({ body: z.string().max(10_000), expectedVersion: z.number().int().positive() }), req.body);
    return editDraft(ctx, await actor(req), (req.params as { id: string }).id, body);
  });
  // "Rechnung senden": invoice PDF from weclapp as a draft with attachment; it is sent only on a click on "Senden".
  // "Rechnung herunterladen": invoice PDF(s) from weclapp kept with the case; sends nothing.
  app.post("/api/w/:ws/cases/:id/invoices/fetch", async (req) => fetchCaseInvoices(ctx, await actor(req), (req.params as { id: string }).id));
  app.post("/api/w/:ws/cases/:id/invoice-reply", async (req) => draftInvoiceReply(ctx, await actor(req), (req.params as { id: string }).id));
  app.post("/api/w/:ws/cases/:id/compose", async (req) => {
    const body = parse(z.object({ instruction: z.string().min(1).max(5_000) }), req.body);
    return composeDraft(ctx, await actor(req), (req.params as { id: string }).id, body.instruction);
  });
  app.post("/api/w/:ws/drafts/:id/polish", async (req) => {
    const body = parse(z.object({ body: z.string().max(10_000), expectedVersion: z.number().int().positive() }), req.body);
    return polishDraft(ctx, await actor(req), (req.params as { id: string }).id, body);
  });
  app.put("/api/w/:ws/drafts/:id/documents", async (req) => {
    const body = parse(z.object({ documentIds: z.array(z.string()).max(10), expectedVersion: z.number().int().positive() }), req.body);
    return setDraftDocuments(ctx, await actor(req), (req.params as { id: string }).id, body);
  });
  // "Datei anhängen": a file for this one reply (PDF, JPG, PNG).
  app.post("/api/w/:ws/drafts/:id/files", { bodyLimit: 4_500_000 }, async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(300), dataBase64: z.string().min(1).max(4_400_000), expectedVersion: z.number().int().positive() }), req.body);
    return attachUploadedFile(ctx, await actor(req), (req.params as { id: string }).id, { name: body.name, data: Buffer.from(body.dataBase64, "base64"), expectedVersion: body.expectedVersion });
  });
  // Workspace PDFs (e.g. return instructions) to attach to replies.
  app.get("/api/w/:ws/documents", async (req) => ({ documents: await listDocuments(ctx, await actor(req)) }));
  app.post("/api/w/:ws/documents", { bodyLimit: 4_500_000 }, async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(300), dataBase64: z.string().min(1).max(4_400_000) }), req.body);
    return uploadDocument(ctx, await actor(req), { name: body.name, data: Buffer.from(body.dataBase64, "base64") });
  });
  app.delete("/api/w/:ws/documents/:id", async (req) => {
    await deleteDocument(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get("/api/w/:ws/documents/:id", async (req, reply) => {
    const doc = await getDocument(ctx, await actor(req), (req.params as { id: string }).id);
    return reply
      .type(doc.content_type)
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`)
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .send(doc.data);
  });
  app.post("/api/w/:ws/drafts/:id/discard", async (req) => {
    await discardDraft(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  // One click "Senden": no separate approval step (0.9.4); all send guards run inside sendDraft.
  app.post("/api/w/:ws/drafts/:id/send", async (req) => {
    const body = parse(z.object({ expectedVersion: z.number().int().positive(), acknowledgeWarnings: z.boolean().default(false) }), req.body);
    return { outboxId: await sendDraft(ctx, await actor(req), (req.params as { id: string }).id, body) };
  });
  app.get("/api/w/:ws/cases/:id/evidence.pdf", async (req, reply) => {
    const pdf = await evidencePdf(ctx, await actor(req), (req.params as { id: string }).id);
    return reply
      .type("application/pdf")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(pdf.name)}`)
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .send(pdf.data);
  });
  app.get("/api/w/:ws/report", async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().default(30) }), req.query);
    return await supportReport(ctx, await actor(req), q.days);
  });
  // --- Refund list ----------------------------------------------------------
  app.get("/api/w/:ws/refunds", async (req) => {
    const q = parse(z.object({ filter: z.enum(["open", "done", "all"]).default("open") }), req.query);
    return listRefunds(ctx, await actor(req), q.filter);
  });
  const refundIds = z.array(z.string().max(40)).min(1).max(50);
  app.post("/api/w/:ws/refunds/done", async (req) => {
    const body = parse(z.object({ conversationIds: refundIds, done: z.boolean(), creditNoteNumber: z.string().max(100).nullable().optional() }), req.body);
    await setRefundDone(ctx, await actor(req), body);
    return { ok: true };
  });
  app.post("/api/w/:ws/refunds/details", async (req) => {
    const body = parse(z.object({ conversationIds: refundIds, amount: z.string().max(30).nullable().optional(), note: z.string().max(1000).nullable().optional(), creditNoteNumber: z.string().max(100).nullable().optional() }), req.body);
    await setRefundDetails(ctx, await actor(req), body);
    return { ok: true };
  });
  app.post("/api/w/:ws/refunds/remove", async (req) => {
    await removeFromRefundList(ctx, await actor(req), parse(z.object({ conversationIds: refundIds }), req.body).conversationIds);
    return { ok: true };
  });
  app.post("/api/w/:ws/cases/:id/refund-list", async (req) => {
    await addToRefundList(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/w/:ws/batch/candidates", async (req) => {
    const body = parse(z.object({ conversationIds: z.array(z.string()).max(50) }), req.body);
    return { items: await batchCandidates(ctx, await actor(req), body.conversationIds) };
  });
  app.post("/api/w/:ws/batch/send", async (req) => {
    const body = parse(z.object({ items: z.array(z.object({ draftId: z.string(), expectedVersion: z.number().int().positive() })).min(1).max(50) }), req.body);
    return { results: await sendMany(ctx, await actor(req), body.items) };
  });
  app.post("/api/w/:ws/outbox/:id/resolve", async (req) => {
    const body = parse(z.object({ resolution: z.enum(["was_sent", "was_not_sent"]) }), req.body);
    await resolveUncertainSend(ctx, await actor(req), (req.params as { id: string }).id, body.resolution);
    return { ok: true };
  });

  // --- Settings (owner) -------------------------------------------------------
  app.get("/api/w/:ws/settings", async (req) => getSettings(ctx, await actor(req)));
  app.put("/api/w/:ws/settings", async (req) => {
    const body = parse(z.object({ replySignature: z.string().max(1000).optional(), replyTone: z.string().max(200).optional(), allowedLinkPrefixes: z.array(z.string().max(300)).max(20).optional(), aiEnabled: z.boolean().optional(), autoInvoice: z.enum(["off", "draft", "send"]).optional(), replyDeadlines: z.record(z.string(), z.union([z.number(), z.string()])).optional() }), req.body);
    await updateWorkspaceSettings(ctx, await actor(req), body);
    return { ok: true };
  });
  app.post("/api/w/:ws/setup-confirmations", async (req) => {
    const body = parse(z.object({ platform: z.string().max(40), done: z.boolean() }), req.body);
    await setSetupConfirmation(ctx, await actor(req), body);
    return { ok: true };
  });
  app.post("/api/w/:ws/ai-key", async (req) => {
    const body = parse(z.object({ apiKey: z.string().max(400).nullable() }), req.body);
    return { check: await setWorkspaceAiKey(ctx, await actor(req), body.apiKey) };
  });
  app.post("/api/w/:ws/ai-key/check", async (req) => checkWorkspaceAiKey(ctx, await actor(req)));
  app.post("/api/w/:ws/merchant-accounts", async (req) => {
    const body = parse(z.object({ name: z.string().max(120), platform: z.string(), orderScopeField: z.string(), orderScopeValue: z.string().max(200).default("") }), req.body);
    return { id: await createMerchantAccount(ctx, await actor(req), body) };
  });
  // Amazon Selling Partner API access (owner). Secrets are never returned; identifiers only masked.
  app.get("/api/w/:ws/amazon-listings", async (req) => getAmazonListingSettings(ctx, await actor(req)));
  app.put("/api/w/:ws/amazon-listings", async (req) => {
    const body = parse(
      z.object({
        region: z.enum(["eu", "na", "fe"]).optional(), marketplaceIds: z.array(z.string().max(20)).min(1).max(20).optional(),
        sellerId: z.string().max(40).optional(), clientId: z.string().max(200).optional(), clientSecret: z.string().max(500).optional(), refreshToken: z.string().max(2000).optional(),
        apiBaseUrl: z.string().max(300).optional(), tokenUrl: z.string().max(300).optional(),
      }),
      req.body,
    );
    await saveAmazonListingConnection(ctx, await actor(req), body);
    return { ok: true };
  });
  app.delete("/api/w/:ws/amazon-listings", async (req) => {
    await deleteAmazonListingConnection(ctx, await actor(req));
    return { ok: true };
  });
  app.post("/api/w/:ws/amazon-listings/check", async (req) => checkAmazonListingConnection(ctx, await actor(req)));
  app.put("/api/w/:ws/erp", async (req) => {
    const body = parse(z.object({ baseUrl: z.string().max(300), apiToken: z.string().max(500).optional(), searchFields: z.array(z.string()).max(5).optional() }), req.body);
    return { id: await upsertWeclappConnection(ctx, await actor(req), body) };
  });
  app.post("/api/w/:ws/erp/check", async (req) => checkErp(ctx, await actor(req)));
  app.post("/api/w/:ws/connections", async (req) => {
    const body = parse(
      z.object({
        displayName: z.string().max(120), tenantId: z.string().max(100), clientId: z.string().max(100), clientSecret: z.string().max(500), mailbox: z.string().max(200),
        ownAddresses: z.array(z.string().max(200)).max(20).optional(), defaultMerchantAccountId: z.string().uuid().nullable().optional(),
        defaultSourcePlatform: z.string().optional(), initialSyncDays: z.number().int().min(1).max(90).optional(), pushNotifications: z.boolean().optional(),
        graphBaseUrl: z.string().optional(), authorityHost: z.string().optional(),
      }),
      req.body,
    );
    return { id: await createGraphConnection(ctx, await actor(req), body) };
  });
  const accountField = z.string().uuid().nullable().optional();
  app.post("/api/w/:ws/connections/kaufland", async (req) => {
    const body = parse(
      z.object({ displayName: z.string().max(120).default("Kaufland"), clientKey: z.string().max(200), secretKey: z.string().max(200), storefronts: z.array(z.string().max(10)).max(20).optional(), defaultMerchantAccountId: accountField, initialSyncDays: z.number().int().min(1).max(90).optional(), baseUrl: z.string().max(300).optional() }),
      req.body,
    );
    return { id: await createKauflandConnection(ctx, await actor(req), body) };
  });
  app.post("/api/w/:ws/connections/mirakl", async (req) => {
    const body = parse(
      z.object({ displayName: z.string().max(120).default("Shop Apotheke"), baseUrl: z.string().max(300), apiKey: z.string().max(500), shopId: z.string().max(20).optional(), defaultMerchantAccountId: accountField, initialSyncDays: z.number().int().min(1).max(90).optional() }),
      req.body,
    );
    return { id: await createMiraklConnection(ctx, await actor(req), body) };
  });
  app.post("/api/w/:ws/connections/:id/mirakl-background-sync", async (req) => {
    await setMiraklBackgroundSync(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ allowed: z.boolean(), evidenceNote: z.string().max(2000).optional() }), req.body));
    return { ok: true };
  });
  app.post("/api/w/:ws/connections/ebay", async (req) => {
    const body = parse(
      z.object({
        displayName: z.string().max(120).default("eBay"), clientId: z.string().max(200), clientSecret: z.string().max(500), ruName: z.string().max(200), sandbox: z.boolean().optional(),
        defaultMerchantAccountId: accountField, initialSyncDays: z.number().int().min(1).max(90).optional(),
        authBaseUrl: z.string().optional(), apiBaseUrl: z.string().optional(), identityBaseUrl: z.string().optional(),
      }),
      req.body,
    );
    return { id: await createEbayConnection(ctx, await actor(req), body) };
  });
  app.post("/api/w/:ws/connections/:id/ebay/authorize", async (req) => ({ url: await startEbayConsent(ctx, await actor(req), (req.params as { id: string }).id) }));
  // eBay redirects the browser here (RuName "auth accepted URL"). The session cookie is
  // SameSite=strict and therefore absent on this cross-site navigation, so the page
  // hands code and state to the web app, which completes the consent with a normal API call.
  app.get("/oauth/ebay/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const params = new URLSearchParams();
    if (q.code && q.state) {
      params.set("ebay_code", q.code.slice(0, 2000));
      params.set("ebay_state", q.state.slice(0, 200));
    } else params.set("ebay_error", (q.error ?? "abgebrochen").slice(0, 100));
    return reply.redirect(`/?${params.toString()}`);
  });
  // eBay Marketplace Account Deletion (required for every production keyset). Public, signed by eBay.
  app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64_000 }, (_req, body, done) => done(null, body));
    hook.get(EBAY_DELETION_PATH, async (req, reply) => {
      const token = ctx.config.EBAY_DELETION_VERIFICATION_TOKEN;
      const code = (req.query as { challenge_code?: string }).challenge_code;
      if (!token || !code || code.length > 500) return reply.code(404).send();
      const endpoint = `${ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, "")}${EBAY_DELETION_PATH}`;
      return reply.code(200).header("content-type", "application/json").send(JSON.stringify({ challengeResponse: ebayChallengeResponse(code, token, endpoint) }));
    });
    hook.post(EBAY_DELETION_PATH, async (req, reply) => {
      if (!ctx.config.EBAY_DELETION_VERIFICATION_TOKEN) return reply.code(404).send();
      const raw = typeof req.body === "string" ? req.body : "";
      const header = req.headers["x-ebay-signature"];
      const result = await handleEbayAccountDeletion(ctx, raw, Array.isArray(header) ? header[0] : header, opts.ebayFetch);
      if (result.status !== 204) req.log.warn({ reason: result.reason }, "eBay-Kontolöschung nicht angenommen");
      return reply.code(result.status).send();
    });
  });
  app.post("/api/oauth/ebay/complete", async (req) => {
    const body = parse(z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(200) }), req.body);
    return completeEbayConsent(ctx, req.userId!, body);
  });
  app.post("/api/w/:ws/connections/:id/check", async (req) => checkChannel(ctx, await actor(req), (req.params as { id: string }).id));
  app.post("/api/w/:ws/connections/:id/sync", async (req) => {
    const a = await actor(req);
    const id = (req.params as { id: string }).id;
    const row = await one(ctx.db, "SELECT 1 FROM channel_connections WHERE workspace_id = $1 AND id = $2", [a.workspaceId, id]);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Verbindung nicht gefunden.");
    await enqueue(ctx.db, { workspaceId: a.workspaceId, type: "mail.sync", payload: { connectionId: id }, dedupeKey: `mail.sync:${id}`, maxAttempts: 3 });
    return { ok: true };
  });
  app.post("/api/w/:ws/connections/:id/send-enabled", async (req) => {
    await setSendEnabled(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ enabled: z.boolean() }), req.body).enabled);
    return { ok: true };
  });
  app.post("/api/w/:ws/connections/:id/platform-sending", async (req) => {
    const body = parse(z.object({ sourcePlatform: z.string(), enabled: z.boolean() }), req.body);
    await setPlatformSending(ctx, await actor(req), (req.params as { id: string }).id, body.sourcePlatform, body.enabled);
    return { ok: true };
  });
  app.post("/api/w/:ws/connections/:id/secret", async (req) => {
    await replaceConnectionSecret(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ clientSecret: z.string().max(500) }), req.body).clientSecret);
    return { ok: true };
  });
  app.delete("/api/w/:ws/connections/:id", async (req) => {
    return await deleteConnection(ctx, await actor(req), (req.params as { id: string }).id);
  });
  app.post("/api/w/:ws/connections/:id/paused", async (req) => {
    await setConnectionPaused(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ paused: z.boolean() }), req.body).paused);
    return { ok: true };
  });
  app.post("/api/w/:ws/connections/:id/rules", async (req) => {
    const body = parse(z.object({ matchType: z.string(), pattern: z.string().max(200), sourcePlatform: z.string(), merchantAccountId: z.string().uuid().nullable().optional(), priority: z.number().int().optional() }), req.body);
    return { id: await addRoutingRule(ctx, await actor(req), (req.params as { id: string }).id, body) };
  });
  app.delete("/api/w/:ws/rules/:id", async (req) => {
    await deleteRoutingRule(ctx, await actor(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/w/:ws/connections/:id/routes", async (req) => {
    await verifyReplyRoute(ctx, await actor(req), (req.params as { id: string }).id, parse(z.object({ sourcePlatform: z.string(), evidenceNote: z.string().max(2000) }), req.body));
    return { ok: true };
  });
  app.delete("/api/w/:ws/connections/:id/routes/:platform", async (req) => {
    const params = req.params as { id: string; platform: string };
    await revokeReplyRoute(ctx, await actor(req), params.id, params.platform);
    return { ok: true };
  });

  // --- Microsoft Graph change notifications (optional push trigger) -------------
  app.post("/webhooks/microsoft/:connectionId", async (req, reply) => {
    const query = req.query as { validationToken?: string };
    if (query.validationToken) return reply.type("text/plain").send(query.validationToken);
    const connectionId = (req.params as { connectionId: string }).connectionId;
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return reply.status(202).send();
    const row = await one<{ workspace_id: string; config: GraphConnectionSettings }>(ctx.db, "SELECT workspace_id, config FROM channel_connections WHERE id = $1", [connectionId]);
    const items = ((req.body as { value?: Array<{ clientState?: string }> } | null)?.value ?? []);
    const expected = Buffer.from(row?.config.clientState ?? "");
    const valid = row && expected.length > 0 && items.some((i) => {
      const got = Buffer.from(i.clientState ?? "");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
    // A notification is only a trigger: the delta sync decides what is new.
    if (valid) await enqueue(ctx.db, { workspaceId: row.workspace_id, type: "mail.sync", payload: { connectionId }, dedupeKey: `mail.sync:${connectionId}`, maxAttempts: 3 });
    return reply.status(202).send();
  });

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/webhooks/")) return reply.status(404).send({ error: "NOT_FOUND", message: "Nicht gefunden." });
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    if (!reply.getHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    return payload;
  });
  return app;
}

/** Reads THEME_DIR/theme.json. A broken file falls back to the default look and says why in the log. */
export function loadTheme(dir: string | undefined, warn: (line: string) => void): Theme {
  if (!dir) return DEFAULT_THEME;
  const file = path.join(dir, "theme.json");
  if (!existsSync(file)) {
    warn(`THEME_DIR gesetzt, aber ${file} fehlt. Standard-Design wird verwendet.`);
    return DEFAULT_THEME;
  }
  try {
    return parseTheme(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    warn(`${file} ist ungültig, Standard-Design wird verwendet: ${(error as Error).message}`);
    return DEFAULT_THEME;
  }
}
