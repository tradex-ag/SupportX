/**
 * Links from the order card to the order itself: in weclapp and on the
 * marketplace where it was placed. Pure, so it can be unit-tested. A link is
 * only built when its address is known for sure; otherwise there is none.
 */

export interface OrderLink {
  label: string;
  href: string;
  /** "refund" opens the marketplace's refund form; it is highlighted when the refund is due. */
  kind?: "refund";
}

export interface OrderLinkInput {
  order: { id: string; orderNumber?: string; orderNumberAtCustomer?: string };
  /** Platform of the case (e.g. "amazon"), and of its seller account if set. */
  platforms: ReadonlyArray<string | null | undefined>;
  /** weclapp API address of this installation, e.g. https://firma.weclapp.com/webapp/api/v2 */
  erpBaseUrl?: string | null;
  /** Mirakl back office of Shop Apotheke, if connected. */
  miraklBaseUrl?: string | null;
}

/** weclapp web page of a sales order, relative to the tenant origin; {id} is the order id (confirmed on a live tenant 2026-10-26). */
export const WECLAPP_ORDER_PATH: string | null = "/app/sales-order/{id}";

const AMAZON_ORDER = /^\d{3}-\d{7}-\d{7}$/;
const EBAY_ORDER = /^\d{2}-\d{5}-\d{5}$/;

function origin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Link to a sales order in weclapp, or null without a tenant address or a numeric order id. */
export function weclappOrderHref(erpBaseUrl: string | null | undefined, orderId: string | null | undefined): string | null {
  const weclapp = origin(erpBaseUrl);
  return weclapp && WECLAPP_ORDER_PATH && orderId && /^\d{1,20}$/.test(orderId) ? weclapp + WECLAPP_ORDER_PATH.replace("{id}", orderId) : null;
}

export function orderLinks(input: OrderLinkInput): OrderLink[] {
  const links: OrderLink[] = [];
  const { order } = input;
  const weclappHref = weclappOrderHref(input.erpBaseUrl, order.id);
  if (weclappHref) links.push({ label: "Auftrag in weclapp", href: weclappHref });
  const numbers = [order.orderNumberAtCustomer, order.orderNumber].map((n) => n?.trim()).filter((n): n is string => !!n);
  const platforms = new Set(input.platforms.filter(Boolean));
  const amazon = numbers.find((n) => AMAZON_ORDER.test(n));
  const ebay = numbers.find((n) => EBAY_ORDER.test(n));
  if (amazon) {
    links.push({ label: "Bestellung in Seller Central", href: `https://sellercentral.amazon.de/orders-v3/order/${amazon}` });
    // Opens Amazon's refund form for this order; the refund itself is done there by a person.
    links.push({ label: "Bestellung erstatten", href: `https://sellercentral.amazon.de/gp/orders-v2/refund?orderID=${amazon}`, kind: "refund" });
  }
  else if (ebay) links.push({ label: "Bestellung bei eBay", href: `https://www.ebay.de/sh/ord/details?orderid=${ebay}` });
  else if (platforms.has("shop_apotheke") && order.orderNumberAtCustomer) {
    const mirakl = origin(input.miraklBaseUrl);
    if (mirakl) links.push({ label: "Bestellung bei Shop Apotheke", href: `${mirakl}/mmp/shop/order/${encodeURIComponent(order.orderNumberAtCustomer)}` });
  }
  return links;
}
