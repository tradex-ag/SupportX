import { trackingHref } from "./tracking.ts";
import type { AllowedFact, OrderRecord, ShipmentFact } from "./contracts.ts";

const SHIPMENT_STATUS_DE: Readonly<Record<string, string>> = {
  NEW: "angelegt, noch nicht als versendet gebucht",
  DELIVERY_NOTE_PRINTED: "Lieferschein gedruckt, noch nicht als versendet gebucht",
  SHIPPED: "als versendet gebucht",
  IN_ROUTE: "als unterwegs vermerkt",
  DELIVERED: "als zugestellt vermerkt",
  CANCELLED: "storniert",
};

/** ERP statuses that record a dispatch. Used to allow "versendet" wording. */
export const DISPATCHED_STATUSES = new Set(["SHIPPED", "IN_ROUTE", "DELIVERED"]);

function day(value: string | undefined): string {
  return value ? value.slice(0, 10) : "unbekannt";
}

function shipmentLabel(shipment: ShipmentFact, index: number): string {
  return shipment.shipmentNumber ? `Lieferung ${shipment.shipmentNumber}` : `Lieferung ${index + 1}`;
}

/**
 * Turn an ERP snapshot into the closed list of facts an AI provider may cite.
 * Each fact names its source and keeps "ERP booking" separate from carrier
 * events: weclapp records dispatch bookings; it is not a carrier scan feed.
 * Customer addresses and payment data are deliberately not included.
 */
export function buildOrderFacts(order: OrderRecord): AllowedFact[] {
  const source = "weclapp";
  const observedAt = order.retrievedAt;
  const facts: AllowedFact[] = [];
  const number = order.orderNumberAtCustomer
    ? `${order.orderNumberAtCustomer} (weclapp-Auftrag ${order.orderNumber ?? order.id})`
    : `weclapp-Auftrag ${order.orderNumber ?? order.id}`;
  facts.push({ id: "order", text: `Bestellung ${number}, Bestelldatum ${day(order.orderDate)}, Auftragsstatus im ERP: ${order.status ?? "unbekannt"}.`, source, observedAt });
  order.lines.forEach((line, i) => {
    const shipped = line.shippedQuantity !== undefined ? `, davon laut ERP versendet: ${line.shippedQuantity}` : "";
    const returned = line.returnedQuantity ? `, zurückgesendet: ${line.returnedQuantity}` : "";
    facts.push({ id: `line.${i + 1}`, text: `Position ${line.position ?? i + 1}: ${line.quantity} × ${line.title}${shipped}${returned}.`, source, observedAt });
  });
  if (order.shipments.length === 0) {
    facts.push({ id: "shipments.none", text: "Zu dieser Bestellung ist im ERP noch keine Lieferung angelegt.", source, observedAt });
  }
  order.shipments.forEach((shipment, i) => {
    const label = shipmentLabel(shipment, i);
    const status = shipment.erpStatus ? SHIPMENT_STATUS_DE[shipment.erpStatus] ?? shipment.erpStatus : "ohne Status";
    const when = shipment.erpStatusAt ? ` (Statusdatum ${day(shipment.erpStatusAt)})` : shipment.shippingDate ? ` (Versanddatum laut ERP ${day(shipment.shippingDate)})` : "";
    facts.push({
      id: `shipment.${i + 1}.status`,
      text: `${label}: im ERP ${status}${when}. Dies ist eine ERP-Buchung, kein Scan des Paketdienstes.`,
      source,
      observedAt,
    });
    if (shipment.items.length > 0) {
      const items = shipment.items.map((item) => `${item.quantity} × ${item.title ?? "Position"}`).join(", ");
      facts.push({ id: `shipment.${i + 1}.items`, text: `${label} enthält: ${items}.`, source, observedAt });
    }
    if (shipment.parcels.length === 0) {
      facts.push({ id: `shipment.${i + 1}.no_tracking`, text: `${label}: im ERP ist keine Sendungsnummer hinterlegt.`, source, observedAt });
    }
    shipment.parcels.forEach((parcel, p) => {
      const parts = [parcel.trackingId ? `Sendungsnummer ${parcel.trackingId}` : "ohne Sendungsnummer"];
      if (parcel.trackingUrl) parts.push(`Trackinglink ${trackingHref(parcel.trackingUrl, parcel.trackingId)}`);
      facts.push({
        id: `shipment.${i + 1}.parcel.${p + 1}`,
        text: `${label}, Paket ${p + 1}: ${parts.join(", ")}. Ein Trackinglink allein belegt weder Versand noch Zustellung.`,
        source,
        observedAt,
      });
    });
  });
  order.invoices.forEach((invoice, i) => {
    facts.push({
      id: `invoice.${i + 1}`,
      text: `Rechnung ${invoice.invoiceNumber ?? invoice.id} vom ${day(invoice.invoiceDate)}, Status: ${invoice.status ?? "unbekannt"}.`,
      source,
      observedAt,
    });
  });
  return facts;
}

export function hasDispatchEvidence(order: OrderRecord | null): boolean {
  return !!order && order.shipments.some((s) => s.erpStatus !== undefined && DISPATCHED_STATUSES.has(s.erpStatus));
}

export function hasDeliveredEvidence(order: OrderRecord | null): boolean {
  return !!order && order.shipments.some((s) => s.erpStatus === "DELIVERED");
}
