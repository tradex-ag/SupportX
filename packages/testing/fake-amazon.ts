import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for Login with Amazon and the SP-API Listings Items API
 * (v2021-08-01), built from the documented request/response shapes. Synthetic
 * data only; it checks the refresh token and access token, records requests and
 * applies `purchasable_offer` end dates like Amazon describes (offer closed =
 * not BUYABLE). It does not claim any behaviour beyond the documentation.
 */
export interface FakeListing {
  sku: string;
  marketplaceId: string;
  asin: string;
  itemName: string;
  productType: string;
  offers: Array<{ offerType: "B2C" | "B2B"; currency: string; amount: string }>;
  quantity?: number;
  closedAt?: string;
}

/** reset: the change is applied, then the connection drops before the answer (ambiguous send). */
export type PatchFault = "none" | "reset" | "invalid" | "forbidden";

export interface FakeAmazon {
  url: string;
  tokenUrl: string;
  listings: FakeListing[];
  requests: Array<{ method: string; path: string; body?: unknown }>;
  fault: { patch: PatchFault };
  close(): Promise<void>;
}

export async function startFakeAmazon(opts: { sellerId: string; clientId: string; clientSecret: string; refreshToken: string; listings: FakeListing[]; port?: number }): Promise<FakeAmazon> {
  const accessToken = "Atza|fake-access";
  const state: Omit<FakeAmazon, "url" | "tokenUrl" | "close"> = { listings: opts.listings, requests: [], fault: { patch: "none" } };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = await readBody(req);
    let parsed: unknown = raw;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { /* form body */ }
    state.requests.push({ method: req.method ?? "", path: url.pathname + url.search, body: parsed });

    if (url.pathname === "/auth/o2/token") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") !== "refresh_token" || form.get("client_id") !== opts.clientId || form.get("client_secret") !== opts.clientSecret) return send(res, 401, { error: "invalid_client", error_description: "Client authentication failed" });
      if (form.get("refresh_token") !== opts.refreshToken) return send(res, 400, { error: "invalid_grant", error_description: "The request has an invalid grant parameter : refresh_token" });
      return send(res, 200, { access_token: accessToken, token_type: "bearer", expires_in: 3600 });
    }
    if (req.headers["x-amz-access-token"] !== accessToken) return send(res, 403, { errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] });

    const m = /^\/listings\/2021-08-01\/items\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(res, 404, { errors: [{ code: "NotFound", message: "Not found" }] });
    const sellerId = decodeURIComponent(m[1]!);
    if (sellerId !== opts.sellerId) return send(res, 403, { errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] });
    const marketplaceId = url.searchParams.get("marketplaceIds") ?? "";
    if (!m[2]) return send(res, 200, { numberOfResults: state.listings.filter((l) => l.marketplaceId === marketplaceId).length, items: [] });
    const sku = decodeURIComponent(m[2]);
    const listing = state.listings.find((l) => l.sku === sku && l.marketplaceId === marketplaceId);
    if (!listing) return send(res, 404, { errors: [{ code: "NOT_FOUND", message: `SKU '${sku}' not found in marketplace ${marketplaceId}` }] });

    if (req.method === "GET") {
      const buyable = !listing.closedAt && listing.offers.length > 0;
      return send(res, 200, {
        sku: listing.sku,
        summaries: [{ marketplaceId, asin: listing.asin, productType: listing.productType, conditionType: "new_new", status: buyable ? ["BUYABLE", "DISCOVERABLE"] : ["DISCOVERABLE"], itemName: listing.itemName }],
        offers: listing.offers.map((o) => ({ marketplaceId, offerType: o.offerType, price: { currencyCode: o.currency, amount: o.amount }, audience: { value: o.offerType === "B2B" ? "B2B" : "ALL", displayName: o.offerType } })),
        fulfillmentAvailability: listing.quantity === undefined ? [] : [{ fulfillmentChannelCode: "DEFAULT", quantity: listing.quantity }],
        issues: [],
      });
    }
    if (req.method === "PATCH") {
      if (state.fault.patch === "forbidden") return send(res, 403, { errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] });
      const body = parsed as { productType?: string; patches?: Array<{ op: string; path: string; value: Array<{ marketplace_id: string; end_at?: { value: string } }> }> };
      if (state.fault.patch === "invalid" || body.productType !== listing.productType) {
        return send(res, 200, { sku, status: "INVALID", submissionId: "sub-invalid", issues: [{ code: "90220", message: "'purchasable_offer' is invalid.", severity: "ERROR" }] });
      }
      const patch = body.patches?.find((p) => p.path === "/attributes/purchasable_offer" && p.op === "merge");
      const endAt = patch?.value.find((v) => v.marketplace_id === marketplaceId)?.end_at?.value;
      if (endAt) listing.closedAt = endAt;
      if (state.fault.patch === "reset") return void req.socket.destroy();
      return send(res, 200, { sku, status: "ACCEPTED", submissionId: `sub-${state.requests.length}`, issues: [] });
    }
    return send(res, 405, { errors: [{ code: "MethodNotAllowed", message: "Method not allowed" }] });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, {
    url,
    tokenUrl: `${url}/auth/o2/token`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
