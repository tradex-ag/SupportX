/**
 * A tracking link that actually carries the parcel number. weclapp often stores the
 * carrier's tracking address without the number (or with a placeholder), so a click
 * opened the carrier page without the parcel. Pure, used by adapter, facts and UI.
 * Only the number is put in; the carrier and host stay as weclapp says.
 */
const PLACEHOLDER = /\{(?:trackingId|trackingNumber|tracking|number|nr|id|0)\}|\$\{[^}]*\}|%s|\[(?:trackingId|trackingNumber|number)\]/i;

/** Known carrier hosts and where they expect the number, for addresses without a slot. */
const CARRIERS: ReadonlyArray<{ host: RegExp; url: (n: string) => string }> = [
  { host: /(^|\.)dhl\.(de|com)$/i, url: (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}` },
  { host: /(^|\.)deutschepost\.de$/i, url: (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}` },
  { host: /(^|\.)dpd\.(de|com)$/i, url: (n) => `https://tracking.dpd.de/status/de_DE/parcel/${n}` },
  { host: /(^|\.)gls-(group\.(eu|com)|pakete\.de)$/i, url: (n) => `https://gls-group.com/DE/de/paketverfolgung?match=${n}` },
  { host: /(^|\.)ups\.com$/i, url: (n) => `https://www.ups.com/track?loc=de_DE&tracknum=${n}` },
  { host: /(^|\.)(myhermes\.de|hermesworld\.com)$/i, url: (n) => `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${n}` },
];

export function trackingHref(url: string | undefined, trackingId: string | undefined): string | undefined {
  // Only web addresses are links; anything else (javascript:, data:) is dropped.
  if (!url || !/^https?:\/\//i.test(url.trim())) return undefined;
  const id = trackingId?.replace(/\s+/g, "");
  if (!id) return url;
  const n = encodeURIComponent(id);
  if (PLACEHOLDER.test(url)) return url.replace(PLACEHOLDER, n);
  if (url.replace(/\s+/g, "").includes(id)) return url;
  // An address ending in "?piececode=" / "&tracknum=" / "#" just lacks the number.
  if (/[=#]$/.test(url)) return url + n;
  let host = "";
  try {
    const u = new URL(url);
    host = u.hostname;
  } catch {
    return url;
  }
  const carrier = CARRIERS.find((c) => c.host.test(host));
  return carrier ? carrier.url(n) : url;
}
