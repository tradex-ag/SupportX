import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the weclapp REST API v2 (GET only), serving synthetic data.
 * Used by contract tests and the demo. It implements only the filters the
 * adapter uses: <field>-eq on all three resources (dotted paths into lists match
 * any element), plus the result envelope and token check.
 */
export interface FakeWeclappData {
  salesOrder: Array<Record<string, unknown>>;
  shipment: Array<Record<string, unknown>>;
  salesInvoice: Array<Record<string, unknown>>;
  article?: Array<Record<string, unknown>>;
  /** Goods receipts; customer returns have incomingGoodsType CUSTOMER_RETURN. */
  incomingGoods?: Array<Record<string, unknown>>;
  shipmentReturnReason?: Array<Record<string, unknown>>;
}

export interface FakeWeclapp {
  baseUrl: string;
  data: FakeWeclappData;
  requests: string[];
  failNext: (status: number) => void;
  close(): Promise<void>;
}

/** Values at a dotted path; a list on the way yields one value per element (weclapp filters like parcels.trackingId-eq). */
function values(record: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [record];
  if (Array.isArray(record)) return record.flatMap((item) => values(item, path));
  if (!record || typeof record !== "object") return [];
  return values((record as Record<string, unknown>)[path[0]!], path.slice(1));
}

/** `rejectFilters` (e.g. "salesInvoice.salesOrderId-eq") answer HTTP 400 like a tenant that does not know the filter. */
export async function startFakeWeclapp(data: FakeWeclappData, opts: { token: string; port?: number; rejectFilters?: ReadonlyArray<string>; forbidden?: ReadonlyArray<string> }): Promise<FakeWeclapp> {
  const requests: string[] = [];
  let failStatus: number | null = null;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["authenticationtoken"] !== opts.token) return send(401, { error: "invalid token" });
    if (failStatus) {
      const status = failStatus;
      failStatus = null;
      return send(status, { error: "simulated failure" });
    }
    if (req.method !== "GET") return send(405, { error: "read-only fake" });
    // Invoice document: a synthetic PDF, or 404 when the record says it has none (`noPdf`).
    const pdf = /^\/webapp\/api\/v2\/salesInvoice\/id\/([^/]+)\/downloadLatestSalesInvoicePdf$/.exec(url.pathname);
    if (pdf) {
      const inv = data.salesInvoice.find((i) => String(i.id) === decodeURIComponent(pdf[1]!));
      if (!inv || inv.noPdf) return send(404, { error: "no document" });
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end(Buffer.from(`%PDF-1.4\n% Rechnung ${String(inv.invoiceNumber)}\n%%EOF`));
    }
    const match = /^\/webapp\/api\/v2\/(salesOrder|shipment|salesInvoice|article|incomingGoods|shipmentReturnReason)$/.exec(url.pathname);
    if (!match) return send(404, { error: "not found" });
    // A user without the right for this resource (e.g. no access to goods receipts).
    if (opts.forbidden?.includes(match[1]!)) return send(403, { error: "forbidden" });
    for (const key of url.searchParams.keys()) {
      if (opts.rejectFilters?.includes(`${match[1]}.${key}`)) return send(400, { error: "unexpected filter property" });
    }
    let rows = data[match[1] as keyof FakeWeclappData] ?? [];
    for (const [key, value] of url.searchParams) {
      if (!key.endsWith("-eq")) continue;
      const field = key.slice(0, -3);
      rows = rows.filter((row) => values(row, field.split(".")).some((v) => String(v ?? "") === value));
    }
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    send(200, { result: rows.slice(0, pageSize) });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/webapp/api/v2`,
    data,
    requests,
    failNext: (status) => {
      failStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
