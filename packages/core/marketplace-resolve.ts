/**
 * Closing a case at the marketplace. Pure; used by the case view.
 *
 * Amazon has no interface to mark a buyer message as resolved or "no response
 * needed" (the SP-API Messaging API only sends certain message types). What exists:
 * - a reply through the buyer-seller relay counts as the answer at Amazon;
 * - every buyer mail carries its own Seller Central link "Fall lösen" / "Resolve case"
 *   (and "Nachricht anzeigen" / "View message") to exactly this message.
 * So SupportX opens that link on "Erledigt"; the person confirms in Seller Central.
 * Nothing here claims the case is closed at Amazon.
 */

export type MarketplaceResolve =
  | { platform: "amazon"; state: "answered" }
  | { platform: "amazon"; state: "open"; url: string; label: string }
  | { platform: "amazon"; state: "no_link" };

const LINKS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:Fall lösen|Resolve case)\s*[:\-]?\s*<?\s*(https:\/\/[^\s>]+)/i, label: "Fall lösen" },
  { re: /(?:Nachricht anzeigen|View message)\s*[:\-]?\s*<?\s*(https:\/\/[^\s>]+)/i, label: "Nachricht anzeigen" },
];

/** Only Seller Central over https; anything else in a mail is not opened. */
export function isSellerCentralUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /^sellercentral(?:-europe)?\.amazon\.(?:de|at|fr|it|es|nl|pl|se|com\.be|co\.uk|com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** The Seller Central link of one Amazon buyer mail, "Fall lösen" before "Nachricht anzeigen". */
export function amazonResolveLink(body: string): { url: string; label: string } | null {
  for (const { re, label } of LINKS) {
    const m = re.exec(body);
    const url = m?.[1]?.replace(/[)\].,;]+$/, "");
    if (url && isSellerCentralUrl(url)) return { url, label };
  }
  return null;
}

type Msg = { direction: string; kind: string; body_text: string; received_at: string | Date };

/**
 * What is still open at the marketplace for this case. `messages` are the case's own
 * messages plus our copies (kind "own_copy"). Null when the platform has no such step.
 */
export function marketplaceResolve(platform: string, messages: Msg[]): MarketplaceResolve | null {
  if (platform !== "amazon") return null;
  const time = (m: Msg) => new Date(m.received_at).getTime();
  const inbound = messages.filter((m) => m.direction === "inbound" && m.kind === "customer").sort((a, b) => time(a) - time(b));
  const last = inbound[inbound.length - 1];
  if (!last) return null;
  const answered = messages.some((m) => m.direction === "outbound" && time(m) > time(last));
  if (answered) return { platform: "amazon", state: "answered" };
  // The newest mail that carries a link; Amazon's thread link is the same for the conversation.
  for (const m of [...inbound].reverse()) {
    const link = amazonResolveLink(m.body_text);
    if (link) return { platform: "amazon", state: "open", ...link };
  }
  return { platform: "amazon", state: "no_link" };
}
