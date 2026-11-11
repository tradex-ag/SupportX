import { DEMO, demoInboundMails, demoWeclappData } from "../packages/testing/demo-data.ts";
import { startFakeGraph } from "../packages/testing/fake-graph.ts";
import { startFakeWeclapp } from "../packages/testing/fake-weclapp.ts";
import { startFakeAmazon } from "../packages/testing/fake-amazon.ts";
import { deflateSync } from "node:zlib";

/** A plain coloured PNG (synthetic "customer photo" for the demo). */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

/**
 * DEMO ONLY: local stand-ins for weclapp and Microsoft Graph with synthetic data.
 * The real adapters talk to these exactly as they would to the real services.
 */
export const DEMO_PORTS = { weclapp: 4011, graph: 4012, amazon: 4013 };

/** Synthetic SP-API app and seller of the demo (Amazon test double only). */
export const DEMO_AMAZON = { sellerId: "A1DEMOSELLER00", clientId: "amzn1.application-oa2-client.demo0000000000000000", clientSecret: "amzn1.oa2-cs.v1.demo-secret", refreshToken: "Atzr|demo-refresh-token" };

export async function startDemoFakes() {
  const weclapp = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken, port: DEMO_PORTS.weclapp });
  const graph = await startFakeGraph({ mailbox: DEMO.mailbox, clientSecret: DEMO.graphSecret, port: DEMO_PORTS.graph });
  const conversations = new Map<string, string>();
  for (const mail of demoInboundMails()) {
    const conversationId = conversations.get(mail.subject) ?? `demo-conv-${mail.key}`;
    conversations.set(mail.subject, conversationId);
    graph.addInbound({ from: mail.from, fromName: mail.fromName, replyTo: mail.replyTo, subject: mail.subject, body: mail.body, conversationId, receivedAt: new Date(Date.now() - mail.hoursAgo * 3_600_000), id: `AAMk-demo-${mail.key}`, internetMessageId: `<demo-${mail.key}@demo-haendler.example.invalid>`,
      attachments: mail.key === "shopify-wrong" ? [{ id: "demo-foto-1", name: "erhaltener-artikel.png", contentType: "image/png", contentBytes: solidPng(320, 240, [190, 40, 40]) }] : undefined });
  }
  const amazon = await startFakeAmazon({
    ...DEMO_AMAZON,
    port: DEMO_PORTS.amazon,
    listings: [{ sku: "D-1001", marketplaceId: "A1PA6795UKMFR9", asin: "B0DEMO1001", itemName: "Demo-Teekanne Glas 1,2 l, 2 Stück", productType: "KITCHEN", offers: [{ offerType: "B2C", currency: "EUR", amount: "24.90" }], quantity: 8 }],
  });
  return { weclapp, graph, amazon };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { weclapp, graph } = await startDemoFakes();
  console.log(`[demo] weclapp-Testdouble: ${weclapp.baseUrl}`);
  console.log(`[demo] Graph-Testdouble:   ${graph.graphBaseUrl} (Postfach ${graph.mailbox}, ${graph.messages.length} synthetische Mails)`);
  console.log(`[demo] Weitere synthetische Kundenmail einspielen: curl -X POST http://127.0.0.1:${DEMO_PORTS.graph}/demo/inbound -H "content-type: application/json" -d '{"from":"test@kunde.example.invalid","subject":"Bestellung #1002","body":"Wo bleibt mein Paket?"}'`);
}
