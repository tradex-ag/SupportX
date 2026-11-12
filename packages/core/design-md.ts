import { z } from "zod";

/**
 * Reads a design description (DESIGN.md) and derives the look of a workspace:
 * colours, fonts, corner radius and product name. Only validated values come
 * out, so a file cannot inject CSS or load foreign resources; colours that would
 * make text unreadable are dropped with a reason.
 */

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FAMILY = /^[\w ,"'-]+$/;

export const COLOR_FIELDS = ["background", "surface", "text", "textSecondary", "muted", "line", "primary", "primaryText", "accent"] as const;
export type ColorField = (typeof COLOR_FIELDS)[number];

export const workspaceThemeSchema = z.object({
  productName: z.string().trim().min(1).max(40).optional(),
  colors: z.object(Object.fromEntries(COLOR_FIELDS.map((f) => [f, z.string().regex(COLOR).optional()])) as Record<ColorField, z.ZodOptional<z.ZodString>>).partial().default({}),
  fonts: z.object({ sans: z.string().regex(FAMILY).max(200).optional(), mono: z.string().regex(FAMILY).max(200).optional() }).default({}),
  radius: z.number().min(0).max(24).optional(),
});
export type WorkspaceTheme = z.infer<typeof workspaceThemeSchema>;

export const COLOR_LABEL: Record<ColorField, string> = {
  background: "Hintergrund",
  surface: "Karten und Felder",
  text: "Text",
  textSecondary: "Nebentext",
  muted: "Hinweise",
  line: "Linien und Rahmen",
  primary: "Hauptknopf",
  primaryText: "Schrift auf dem Hauptknopf",
  accent: "Akzent",
};

/** Keyword rules, most specific first; the first colour of a matching line wins. */
const RULES: ReadonlyArray<[ColorField, RegExp]> = [
  // "on-surface" / "on-background" (Material-style tokens) name the text colour, not the surface.
  ["text", /on[- ]?(surface|background)\b/],
  ["primaryText", /on[- ]?primary|button[- ]?text|primary[- ]?text|text auf (dem )?(haupt)?knopf|knopfschrift|schrift auf/],
  ["textSecondary", /secondary text|text[- ]?secondary|sekundär|nebentext|graphite/],
  ["muted", /muted|gedämpft|hinweis|caption|placeholder|subtle/],
  ["background", /hintergrund|background|\bbg\b|canvas|seite\b/],
  ["surface", /surface|karte|card|fläche|panel|container/],
  ["line", /linie|\bline\b|border|rahmen|divider|trenn|outline/],
  ["accent", /akzent|accent|brand|marke|signal|highlight/],
  ["primary", /primary|primär|haupt|button|knopf|cta/],
  ["text", /\btext\b|schriftfarbe|foreground|\bink\b|body|fließtext/],
];

function expand(hex: string): string {
  const h = hex.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

function luminance(hex: string): number {
  const h = expand(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

const DEFAULTS: Record<ColorField, string> = {
  background: "#f8f9fa", surface: "#ffffff", text: "#111111", textSecondary: "#303030", muted: "#6a6e73",
  line: "#e8e8e8", primary: "#111111", primaryText: "#ffffff", accent: "#d52b1e",
};

export interface DesignReading {
  theme: WorkspaceTheme;
  /** What was taken over, for the preview. */
  found: Array<{ field: string; label: string; value: string }>;
  warnings: string[];
}

function cleanFamily(raw: string, fallback: string): string | undefined {
  const name = raw.replace(/[`*_]/g, "").replace(/\(.*?\)/g, "").split(/[;|]/)[0]!.trim().replace(/[.,]$/, "");
  if (!name || name.length > 120 || !FAMILY.test(name)) return undefined;
  return /,/.test(name) ? name : `"${name.replace(/["']/g, "")}", ${fallback}`;
}

/** Checks a theme (from a file or from the client) and makes the colours readable. */
export function checkTheme(input: WorkspaceTheme): { theme: WorkspaceTheme; warnings: string[] } {
  const theme = workspaceThemeSchema.parse(input);
  const colors = { ...theme.colors };
  const warnings: string[] = [];
  const value = (f: ColorField) => colors[f] ?? DEFAULTS[f];
  if (colors.primary && !colors.primaryText) {
    colors.primaryText = contrast(colors.primary, "#ffffff") >= contrast(colors.primary, "#111111") ? "#ffffff" : "#111111";
  }
  const pairs: Array<[ColorField, ColorField, number, string]> = [
    ["text", "background", 4.5, "Text auf dem Hintergrund"],
    ["text", "surface", 4.5, "Text auf Karten"],
    ["primaryText", "primary", 4.5, "Schrift auf dem Hauptknopf"],
    ["muted", "surface", 3, "Hinweise auf Karten"],
  ];
  for (const [fg, bg, min, label] of pairs) {
    const ratio = contrast(value(fg), value(bg));
    if (ratio >= min) continue;
    warnings.push(`${label} wäre schlecht lesbar (Kontrast ${ratio.toFixed(1)}:1, nötig ${min}:1). Dafür bleibt das Standard-Design.`);
    delete colors[fg];
    delete colors[bg];
  }
  return { theme: { ...theme, colors }, warnings };
}

export function readDesignMd(text: string): DesignReading {
  const warnings: string[] = [];
  const raw: WorkspaceTheme = { colors: {}, fonts: {} };

  // A fenced JSON block in theme.json form wins over prose.
  for (const block of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    try {
      const parsed = JSON.parse(block[1]!) as Record<string, unknown>;
      const candidate = workspaceThemeSchema.safeParse({ productName: parsed.productName, colors: parsed.colors ?? {}, fonts: { sans: (parsed.fonts as Record<string, unknown> | undefined)?.sans, mono: (parsed.fonts as Record<string, unknown> | undefined)?.mono }, radius: parsed.radius });
      if (candidate.success) Object.assign(raw, { ...candidate.data, colors: { ...candidate.data.colors }, fonts: { ...candidate.data.fonts } });
    } catch {
      // not JSON: ignore the block
    }
  }

  let heading = "";
  let radiusWindow = 0;
  // CSS tokens named in the file (`--go` → #3a6b35), so `var(--go)` elsewhere resolves.
  const tokens = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /(--[\w-]+)[^#\n]*?(#(?:[0-9a-f]{6}|[0-9a-f]{3})\b)/i.exec(line);
    if (m && !tokens.has(m[1]!.toLowerCase())) tokens.set(m[1]!.toLowerCase(), expand(m[2]!));
  }
  for (const line of text.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (/^#{1,6}\s/.test(line)) heading = lower;
    // First colour on the line: a hex value or a var(--token) defined elsewhere in the file.
    const refs = [...lower.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b|var\((--[\w-]+)\)/g)]
      .map((m) => ({ index: m.index!, length: m[0].length, value: m[1] ? tokens.get(m[1]) : expand(m[0]) }))
      .filter((r) => r.value);
    const ref = refs[0];
    if (ref) {
      // The token or name before the colour decides first (e.g. `--muted`), then the description after it.
      const before = lower.slice(0, ref.index);
      const after = lower.slice(ref.index + ref.length);
      // Status colours, dark surfaces and the navigation are not part of the base look.
      const skip = /danger|error|fehler|success|erfolg|warning|warnung|navigation|sidebar|seitenleiste|nav-/.test(before) || /auf ink|on ink|on dark|dunkel|dark mode/.test(lower);
      // The role named first wins (a row "Text | --text → --muted" is the text colour).
      const pick = (part: string) => RULES
        .map(([f, re]) => ({ f, at: raw.colors[f] ? -1 : part.search(re) }))
        .filter((c) => c.at >= 0)
        .sort((a, b) => a.at - b.at)[0]?.f;
      const field = skip ? undefined : pick(before) ?? pick(after);
      if (field) raw.colors[field] = ref.value!;
    }
    // Fonts: bold names in a typography context (each judged by the words just before it),
    // otherwise an explicit "font-family: …" / "Schrift: …".
    const fontLine = !/smoothing|variant|feature|size|weight|gewicht|größe/.test(lower);
    const explicit = fontLine ? /(?:font-?family|schriftart|schrift|font|typeface)\s*[:=]\s*(.+)$/i.exec(line)?.[1] : undefined;
    const bolds = fontLine && (explicit || /schrift|typo|font/.test(heading) || /schrift|font/.test(lower)) ? [...line.matchAll(/\*\*([A-Z][\w -]{1,40})\*\*/g)] : [];
    const takeFont = (name: string, mono: boolean) => {
      if (mono) raw.fonts.mono ??= cleanFamily(name, "ui-monospace, monospace");
      else raw.fonts.sans ??= cleanFamily(name, "Arial, sans-serif");
    };
    // Font tables in a typography section: "| Inter | `--font-body` | Fließtext |".
    const row = /schrift|typo|font/.test(heading) ? /^\|\s*([A-Z][\w -]{1,40}?)\s*\|(.*)$/.exec(line) : null;
    if (row && !/^(familie|family|schrift|font|name|token)$/i.test(row[1]!.trim())) {
      const rest = row[2]!.toLowerCase();
      if (/mono|code/.test(rest) || /mono/i.test(row[1]!)) takeFont(row[1]!, true);
      else if (/body|text|fließtext|sans|\bui\b/.test(rest)) takeFont(row[1]!, false);
    } else if (bolds.length > 0) {
      for (const b of bolds) takeFont(b[1]!, /mono/i.test(b[1]!) || /mono|code/.test(lower.slice(Math.max(0, b.index! - 24), b.index)));
    } else if (explicit) {
      takeFont(explicit, /mono|code/.test(lower) || /mono/i.test(explicit));
    }
    // Radius: on the line that names it or in the few lines right after.
    if (/radius|radien|radii|ecken|rundung|corner|rounded/.test(lower)) radiusWindow = 4;
    if (raw.radius === undefined && radiusWindow > 0) {
      const px = /(\d+(?:\.\d+)?)\s*px/.exec(lower)?.[1];
      if (px) raw.radius = Math.min(24, Math.max(0, Number(px)));
    }
    radiusWindow = Math.max(0, radiusWindow - 1);
    if (!raw.productName) {
      const name = /(?:produktname|product name)\s*[:=]\s*[*_`"„]*([^*_`"“\n|]{1,40})/i.exec(line)?.[1]?.trim();
      if (name) raw.productName = name;
    }
  }

  const { theme, warnings: contrastWarnings } = checkTheme(raw);
  warnings.push(...contrastWarnings);
  const found: DesignReading["found"] = [];
  if (theme.productName) found.push({ field: "productName", label: "Produktname", value: theme.productName });
  for (const f of COLOR_FIELDS) if (theme.colors[f]) found.push({ field: `colors.${f}`, label: COLOR_LABEL[f], value: theme.colors[f]! });
  if (theme.fonts.sans) found.push({ field: "fonts.sans", label: "Schrift", value: theme.fonts.sans });
  if (theme.fonts.mono) found.push({ field: "fonts.mono", label: "Schrift für Code und Kennungen", value: theme.fonts.mono });
  if (theme.radius !== undefined) found.push({ field: "radius", label: "Eckenradius", value: `${theme.radius} px` });
  if (found.length === 0) warnings.push("In der Datei wurden keine Farben, Schriften oder Radien erkannt. Farben bitte als #rrggbb mit Rolle angeben, z. B. „Hintergrund: #ffffff“.");
  if (/fonts\.googleapis|@import|url\(/i.test(text)) warnings.push("Externe Schriftdateien und Links werden nicht geladen. Die Schrift wird nur genutzt, wenn sie auf dem Gerät vorhanden ist.");
  return { theme, found, warnings };
}

const FIELD_HELP: Record<ColorField, string> = {
  background: "Hintergrund der Seite",
  surface: "Karten, Felder und Listen",
  text: "Haupttext",
  textSecondary: "Nebentext",
  muted: "Hinweise und kleine Beschriftungen",
  line: "Linien und Rahmen",
  primary: "Hauptknopf und aktive Reiter",
  primaryText: "Schrift auf dem Hauptknopf",
  accent: "Akzent und Signalfarbe",
};

/** Full set of values to write out: the workspace's own values over the installation look. */
export interface FullDesign {
  productName: string;
  colors: Record<ColorField, string>;
  fonts: { sans: string; mono: string };
  radius: number;
}

/**
 * Writes a DESIGN.md that `readDesignMd` reads back to the same values: a short guide
 * plus the JSON block. Used as template (standard look) and as export of the current look.
 */
export function writeDesignMd(design: FullDesign, opts: { custom: boolean }): string {
  const json = {
    productName: design.productName,
    colors: Object.fromEntries(COLOR_FIELDS.map((f) => [f, design.colors[f]])),
    fonts: design.fonts,
    radius: design.radius,
  };
  const rows = COLOR_FIELDS.map((f) => `| \`${f}\` | ${COLOR_LABEL[f]} | ${FIELD_HELP[f]} |`).join("\n");
  return `# Design für SupportX

${opts.custom ? "Das ist das aktuelle Design dieses Arbeitsbereichs." : "Das ist das Standard-Design von SupportX als Vorlage."}
Werte im JSON-Block unten ändern und die Datei unter **Einstellungen → Design** wieder hochladen.
Vor dem Übernehmen zeigt SupportX eine Vorschau.

## Regeln

- Farben als Hex-Wert mit sechs Stellen (Raute, dann rrggbb).
- Farbpaare, die schlecht lesbar wären (z. B. heller Text auf hellem Hintergrund), übernimmt SupportX nicht.
- Schriften werden nur genutzt, wenn sie auf dem Gerät vorhanden sind. Externe Schriftdateien und Links lädt SupportX nicht.
- Eckenradius in Pixeln, 0 bis 24.
- \`productName\` steht oben links, solange kein Logo hochgeladen ist.
- Felder, die fehlen, bleiben beim Standard.

## Felder

| Feld | In SupportX | Wofür |
| --- | --- | --- |
${rows}
| \`fonts.sans\` | Schrift | Alle Texte |
| \`fonts.mono\` | Schrift für Code und Kennungen | Bestellnummern, Kennungen |
| \`radius\` | Eckenradius | Karten, Knöpfe, Felder |

Statt des JSON-Blocks geht auch Fließtext mit Rolle und Wert je Zeile, z. B. Hintergrund, Schrift oder Eckenradius
mit einem Wert dahinter. Der JSON-Block hat Vorrang.

## Werte

\`\`\`json
${JSON.stringify(json, null, 2)}
\`\`\`
`;
}
