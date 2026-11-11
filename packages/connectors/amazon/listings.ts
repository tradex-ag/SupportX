import type { AmazonRegion } from "../../core/amazon-marketplaces.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";

/**
 * Amazon Selling Partner API, Listings Items API v2021-08-01, for one action:
 * close an offer of the operator's own listing (make it non-purchasable) after a
 * person confirmed it in a case. Reads the listing first; never creates,
 * deletes or reprices listings.
 *
 * Authentication: Login with Amazon (LWA) refresh token of the seller who
 * authorised the operator's SP-API app. The app needs the role "Product Listing"
 * (getListingsItem, patchListingsItem, searchListingsItems). Since 2023 SP-API
 * calls need no AWS signature, only the LWA access token (x-amz-access-token).
 *
 * Closing: patch `purchasable_offer` with op "merge" and an `end_at` date in the
 * past (Amazon: "Manage purchasable offer"). Price and stock stay untouched, so
 * the offer can be opened again in Seller Central by removing the end date.
 */

export const LISTINGS_VERSION = "2021-08-01";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const REGION_HOSTS: Record<AmazonRegion, string> = {
  eu: "https://sellingpartnerapi-eu.amazon.com",
  na: "https://sellingpartnerapi-na.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};
const OFFICIAL_HOSTS = new Set([...Object.values(REGION_HOSTS).map((u) => new URL(u).hostname), new URL(LWA_TOKEN_URL).hostname]);

export function isOfficialAmazonHost(url: URL): boolean {
  return OFFICIAL_HOSTS.has(url.hostname);
}

export interface AmazonListingsConfig {
  region: AmazonRegion;
  sellerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Test doubles only (ALLOW_TEST_ENDPOINTS). */
  apiBaseUrl?: string;
  tokenUrl?: string;
  allowTestEndpoints: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ListingOffer {
  /** B2C or B2B as Amazon reports it. */
  offerType: string;
  currency: string;
  amount?: string;
  /** purchasable_offer selector: "ALL" for the consumer offer, "B2B" for business. */
  audience: string;
}

export interface ListingIssue {
  code: string;
  message: string;
  severity: string;
}

export interface ListingInfo {
  sku: string;
  marketplaceId: string;
  asin?: string;
  itemName?: string;
  productType?: string;
  /** Amazon summary status, e.g. BUYABLE, DISCOVERABLE. Empty: not buyable. */
  status: string[];
  offers: ListingOffer[];
  /** Live quantity per fulfillment channel (DEFAULT = seller-fulfilled, AMAZON_* = FBA). */
  fulfillment: Array<{ channel: string; quantity?: number }>;
  issues: ListingIssue[];
}

export interface PatchResult {
  /** ACCEPTED: Amazon took the change for processing. INVALID: rejected, see issues. */
  status: string;
  submissionId?: string;
  issues: ListingIssue[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function issuesOf(v: unknown): ListingIssue[] {
  return arr(v).map((i) => ({ code: str(rec(i).code) ?? "", message: str(rec(i).message) ?? "", severity: str(rec(i).severity) ?? "" }));
}

/** Parses a getListingsItem response for one marketplace. Exported for contract tests. */
export function parseListing(raw: unknown, marketplaceId: string): ListingInfo {
  const body = rec(raw);
  const summary = rec(arr(body.summaries).find((s) => rec(s).marketplaceId === marketplaceId) ?? arr(body.summaries)[0]);
  const offers = arr(body.offers)
    .map(rec)
    .filter((o) => !o.marketplaceId || o.marketplaceId === marketplaceId)
    .map((o) => {
      const offerType = str(o.offerType) ?? "B2C";
      const price = rec(o.price);
      return {
        offerType,
        currency: str(price.currencyCode) ?? str(price.currency) ?? "",
        amount: str(price.amount),
        audience: str(rec(o.audience).value) ?? (offerType === "B2B" ? "B2B" : "ALL"),
      };
    });
  return {
    sku: str(body.sku) ?? "",
    marketplaceId,
    asin: str(summary.asin),
    itemName: str(summary.itemName),
    productType: str(summary.productType),
    status: arr(summary.status).filter((s): s is string => typeof s === "string"),
    offers,
    fulfillment: arr(body.fulfillmentAvailability).map((f) => ({ channel: str(rec(f).fulfillmentChannelCode) ?? "", quantity: typeof rec(f).quantity === "number" ? (rec(f).quantity as number) : undefined })),
    issues: issuesOf(body.issues),
  };
}

/** A date clearly in the past in every marketplace time zone (yesterday, UTC). */
export function closingDate(now: Date): string {
  return new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
}

/** The patch that closes all offers of a listing in one marketplace. Exported for contract tests. */
export function closeOfferPatch(listing: ListingInfo, now: Date): { productType: string; patches: unknown[] } {
  if (!listing.productType) throw new Error("Amazon nennt keinen Produkttyp für dieses Angebot.");
  const endAt = closingDate(now);
  return {
    productType: listing.productType,
    patches: [
      {
        op: "merge",
        path: "/attributes/purchasable_offer",
        value: listing.offers.map((o) => ({ marketplace_id: listing.marketplaceId, currency: o.currency, audience: o.audience, end_at: { value: endAt } })),
      },
    ],
  };
}

export class AmazonListingsClient {
  readonly #c: AmazonListingsConfig;
  readonly #api: URL;
  readonly #token: URL;
  #access: { token: string; expiresAt: number } | null = null;

  constructor(config: AmazonListingsConfig) {
    if (!config.sellerId.trim() || !config.clientId.trim() || !config.clientSecret || !config.refreshToken) throw new Error("Amazon-Zugangsdaten unvollständig.");
    if (!REGION_HOSTS[config.region]) throw new Error(`Unbekannte Amazon-Region: ${config.region}`);
    this.#c = config;
    this.#api = assertAllowedEndpoint(config.apiBaseUrl ?? REGION_HOSTS[config.region], config.allowTestEndpoints, isOfficialAmazonHost);
    this.#token = assertAllowedEndpoint(config.tokenUrl ?? LWA_TOKEN_URL, config.allowTestEndpoints, isOfficialAmazonHost);
  }

  get #timeout(): number {
    return this.#c.timeoutMs ?? 15_000;
  }

  async #accessToken(): Promise<string> {
    if (this.#access && this.#access.expiresAt > Date.now() + 60_000) return this.#access.token;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.#c.refreshToken, client_id: this.#c.clientId, client_secret: this.#c.clientSecret }).toString();
    let res: unknown;
    try {
      res = await requestJson(this.#token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body, timeoutMs: this.#timeout, fetchImpl: this.#c.fetchImpl });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 400 || error.status === 401)) {
        // Not a send: a failed token request never changed anything at Amazon.
        throw new HttpError(`Anmeldung bei Amazon fehlgeschlagen: Client-ID, Client-Secret oder Refresh-Token passen nicht (${error.message}).`, error.status, false, false);
      }
      throw new HttpError(error instanceof Error ? error.message : String(error), error instanceof HttpError ? error.status : 0, true, false);
    }
    const token = str(rec(res).access_token);
    if (!token) throw new HttpError("Amazon lieferte kein Zugriffstoken.", 502, false);
    const expiresIn = typeof rec(res).expires_in === "number" ? (rec(res).expires_in as number) : 3600;
    this.#access = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  #itemUrl(sku: string, params: Record<string, string>): URL {
    const url = new URL(`/listings/${LISTINGS_VERSION}/items/${encodeURIComponent(this.#c.sellerId.trim())}/${encodeURIComponent(sku)}`, this.#api);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  /** The listing as Amazon has it now, or null if this seller has no listing with this SKU. */
  async getListing(sku: string, marketplaceId: string): Promise<ListingInfo | null> {
    const token = await this.#accessToken();
    try {
      const raw = await requestJson(this.#itemUrl(sku, { marketplaceIds: marketplaceId, includedData: "summaries,offers,fulfillmentAvailability,issues", issueLocale: "de_DE" }), {
        method: "GET",
        headers: { "x-amz-access-token": token, accept: "application/json" },
        timeoutMs: this.#timeout,
        fetchImpl: this.#c.fetchImpl,
      });
      return parseListing(raw, marketplaceId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw explain(error);
    }
  }

  /** Closes the offer(s) of the listing in its marketplace. A timeout is reported as uncertain. */
  async closeOffer(listing: ListingInfo, now: Date): Promise<PatchResult> {
    const token = await this.#accessToken();
    try {
      const raw = await requestJson(this.#itemUrl(listing.sku, { marketplaceIds: listing.marketplaceId, issueLocale: "de_DE" }), {
        method: "PATCH",
        headers: { "x-amz-access-token": token, accept: "application/json" },
        body: JSON.stringify(closeOfferPatch(listing, now)),
        timeoutMs: this.#timeout,
        fetchImpl: this.#c.fetchImpl,
      });
      const body = rec(raw);
      return { status: str(body.status) ?? "UNKNOWN", submissionId: str(body.submissionId), issues: issuesOf(body.issues) };
    } catch (error) {
      // Amazon answers a rejected patch with 400 and a body listing the issues.
      throw explain(error);
    }
  }

  /** Token exchange plus one listing search: proves the role "Product Listing" and the seller ID. */
  async checkAccess(marketplaceId: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const token = await this.#accessToken();
      const url = new URL(`/listings/${LISTINGS_VERSION}/items/${encodeURIComponent(this.#c.sellerId.trim())}`, this.#api);
      url.searchParams.set("marketplaceIds", marketplaceId);
      url.searchParams.set("pageSize", "1");
      const raw = await requestJson(url, { method: "GET", headers: { "x-amz-access-token": token, accept: "application/json" }, timeoutMs: this.#timeout, fetchImpl: this.#c.fetchImpl });
      const total = rec(raw).numberOfResults;
      return { ok: true, detail: `Anmeldung und Rolle „Product Listing“ in Ordnung${typeof total === "number" ? `, ${total} ${total === 1 ? "Angebot" : "Angebote"} auf dem ersten Marktplatz` : ""}.` };
    } catch (error) {
      return { ok: false, detail: explain(error).message };
    }
  }
}

function explain(error: unknown): Error {
  if (!(error instanceof HttpError)) return error instanceof Error ? error : new Error(String(error));
  if (error.status === 403) {
    return new HttpError("Amazon verweigert den Zugriff (403). Die SP-API-App braucht die Rolle „Product Listing“, und der Verkäufer muss die App für genau dieses Konto autorisiert haben. Die Verkäufer-ID muss zu diesem Konto gehören.", 403, false, error.uncertain);
  }
  return error;
}
