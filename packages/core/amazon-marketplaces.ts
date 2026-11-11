/**
 * Amazon marketplaces the Selling Partner API serves, by region endpoint.
 * Public identifiers from Amazon's "Marketplace IDs" reference; no credentials.
 * Shared by server and browser (settings form, case view).
 */
export type AmazonRegion = "eu" | "na" | "fe";

export interface AmazonMarketplace {
  id: string;
  country: string;
  label: string;
  region: AmazonRegion;
}

export const AMAZON_MARKETPLACES: ReadonlyArray<AmazonMarketplace> = [
  { id: "A1PA6795UKMFR9", country: "DE", label: "Amazon.de", region: "eu" },
  { id: "A1RKKUPIHCS9HS", country: "ES", label: "Amazon.es", region: "eu" },
  { id: "A13V1IB3VIYZZH", country: "FR", label: "Amazon.fr", region: "eu" },
  { id: "APJ6JRA9NG5V4", country: "IT", label: "Amazon.it", region: "eu" },
  { id: "A1805IZSGTT6HS", country: "NL", label: "Amazon.nl", region: "eu" },
  { id: "AMEN7PMS3EDWL", country: "BE", label: "Amazon.com.be", region: "eu" },
  { id: "A1C3SOZRARQ6R3", country: "PL", label: "Amazon.pl", region: "eu" },
  { id: "A2NODRKZP88ZB9", country: "SE", label: "Amazon.se", region: "eu" },
  { id: "A1F83G8C2ARO7P", country: "UK", label: "Amazon.co.uk", region: "eu" },
  { id: "A28R8C7NBKEWEA", country: "IE", label: "Amazon.ie", region: "eu" },
  { id: "A33AVAJ2PDY3EV", country: "TR", label: "Amazon.com.tr", region: "eu" },
  { id: "ATVPDKIKX0DER", country: "US", label: "Amazon.com", region: "na" },
  { id: "A2EUQ1WTGCTBG2", country: "CA", label: "Amazon.ca", region: "na" },
  { id: "A1AM78C64UM0Y8", country: "MX", label: "Amazon.com.mx", region: "na" },
  { id: "A1VC38T7YXB528", country: "JP", label: "Amazon.co.jp", region: "fe" },
  { id: "A39IBJ37TRP1C6", country: "AU", label: "Amazon.com.au", region: "fe" },
];

export const AMAZON_REGION_LABEL: Record<AmazonRegion, string> = { eu: "Europa", na: "Nordamerika", fe: "Fernost" };

export function amazonMarketplace(id: string): AmazonMarketplace | undefined {
  return AMAZON_MARKETPLACES.find((m) => m.id === id);
}

export function amazonMarketplaceLabel(id: string): string {
  return amazonMarketplace(id)?.label ?? id;
}

/** Shows the start and end of a stored identifier only (e.g. the LWA client ID). */
export function maskIdentifier(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}
