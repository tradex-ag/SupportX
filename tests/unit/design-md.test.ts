import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTheme, COLOR_FIELDS, contrast, readDesignMd, writeDesignMd, type FullDesign } from "../../packages/core/design-md.ts";
import { DEFAULT_THEME } from "../../packages/core/theme.ts";
import { logoType } from "../../packages/services/design.ts";

const SAMPLE = `# Design-Basis

## Farben
| Token | Wert | Rolle |
| --- | --- | --- |
| \`--paper\` | #ffffff | Hintergrund der Seite |
| \`--ink\` | #111111 | Text |
| \`--graphite\` | #303030 | Nebentext |
| \`--ink-muted\` | #6a6e73 | Hinweise und Captions |
| \`--hairline\` | #e8e8e8 | Linien und Rahmen |
| \`--brand\` | #6D33D6 | Akzent |
| \`--danger\` | #b3261e | Fehler |
| Text auf Ink | #ffffff | on dark |

## Typografie
Schrift: **Geist**, Code in **JetBrains Mono**.

## Ecken
Radius für Karten und Knöpfe:
- 2px überall
`;

describe("readDesignMd", () => {
  it("takes colours by role, fonts and radius from prose, and skips status colours", () => {
    const r = readDesignMd(SAMPLE);
    assert.equal(r.theme.colors.background, "#ffffff");
    assert.equal(r.theme.colors.text, "#111111");
    assert.equal(r.theme.colors.textSecondary, "#303030");
    assert.equal(r.theme.colors.muted, "#6a6e73");
    assert.equal(r.theme.colors.line, "#e8e8e8");
    assert.equal(r.theme.colors.accent, "#6d33d6");
    assert.ok(!Object.values(r.theme.colors).includes("#b3261e"), "the error colour is not part of the base look");
    assert.match(r.theme.fonts.sans ?? "", /^"Geist"/);
    assert.match(r.theme.fonts.mono ?? "", /JetBrains Mono/);
    assert.equal(r.theme.radius, 2);
    assert.deepEqual(r.warnings, []);
  });

  it("prefers a JSON block in theme.json form", () => {
    const r = readDesignMd('Text\n```json\n{"productName":"Muster Support","colors":{"primary":"#1e5a2b"},"radius":6}\n```\nHintergrund: #ffffff');
    assert.equal(r.theme.productName, "Muster Support");
    assert.equal(r.theme.colors.primary, "#1e5a2b");
    assert.equal(r.theme.colors.primaryText, "#ffffff", "a readable text colour for the button is picked");
    assert.equal(r.theme.radius, 6);
  });

  it("drops unreadable colour pairs with a reason", () => {
    const r = readDesignMd("Hintergrund: #ffffff\nText: #eeeeee");
    assert.equal(r.theme.colors.text, undefined);
    assert.equal(r.theme.colors.background, undefined);
    assert.match(r.warnings.join(" "), /schlecht lesbar/);
  });

  it("says so when nothing was found and never takes external links", () => {
    const r = readDesignMd("# Nur Text\n@import url(https://fonts.googleapis.com/css?family=X);");
    assert.equal(r.found.length, 0);
    assert.match(r.warnings.join(" "), /keine Farben/);
    assert.match(r.warnings.join(" "), /Externe Schriftdateien/);
  });

  it("rejects values that could break out of the CSS", () => {
    assert.throws(() => checkTheme({ colors: { text: "red;}body{display:none" }, fonts: {} }));
    assert.throws(() => checkTheme({ colors: {}, fonts: { sans: "X;}body{display:none" } }));
    assert.equal(Math.round(contrast("#ffffff", "#000000")), 21);
  });
});

describe("DESIGN.md formats and export", () => {
  it("reads token-style files with front matter (on-surface is text, fontFamily, rounded)", () => {
    const r = readDesignMd(`---
name: Beispiel
colors:
  primary: "#1a4d8f"
  on-primary: "#ffffff"
  surface: "#ffffff"
  on-surface: "#1b1b1f"
  background: "#f5f7fa"
typography:
  body:
    fontFamily: Inter
    fontSize: 16px
rounded:
  md: 8px
---
# Beispiel`);
    assert.equal(r.theme.colors.primary, "#1a4d8f");
    assert.equal(r.theme.colors.primaryText, "#ffffff");
    assert.equal(r.theme.colors.surface, "#ffffff", "on-surface does not overwrite the surface");
    assert.equal(r.theme.colors.text, "#1b1b1f");
    assert.equal(r.theme.colors.background, "#f5f7fa");
    assert.match(r.theme.fonts.sans ?? "", /^"Inter"/);
    assert.equal(r.theme.radius, 8);
  });

  it("writes a template that reads back to exactly the same values", () => {
    const { soft: _soft, ...colors } = DEFAULT_THEME.colors;
    const design: FullDesign = { productName: "Mein Support", colors, fonts: { sans: DEFAULT_THEME.fonts.sans, mono: DEFAULT_THEME.fonts.mono }, radius: 6 };
    const text = writeDesignMd(design, { custom: false });
    assert.match(text, /Vorlage/);
    const r = readDesignMd(text);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.theme.productName, "Mein Support");
    for (const f of COLOR_FIELDS) assert.equal(r.theme.colors[f], colors[f], f);
    assert.equal(r.theme.fonts.sans, design.fonts.sans);
    assert.equal(r.theme.fonts.mono, design.fonts.mono);
    assert.equal(r.theme.radius, 6);
  });

  it("recognises logos by their first bytes and refuses SVG", () => {
    assert.equal(logoType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
    assert.equal(logoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(logoType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
    assert.equal(logoType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  });
});

describe("style guides with token tables", () => {
  it("reads roles from the first column, resolves var(--token), skips status and navigation rows, reads font tables and Radien", () => {
    const r = readDesignMd(`# Shop – Style Guide

## Farben

| Rolle | Token | Wert | Einsatz |
|---|---|---|---|
| Seite | \`--bg\` | \`#fafaf8\` | Hintergrund |
| Karte | \`--panel\` | \`#ffffff\` | Karten, Dialoge |
| Linie | \`--hairline\` | \`#e7e8e3\` | Rahmen |
| Text | \`--text\` → \`--muted\` → \`--faint\` | \`#1a1d1a\` … \`#9ca199\` | absteigende Wichtigkeit |
| Akzent | \`--go\`, \`--go-tint\` | \`#2d5b8a\` | Primärknopf, Links, Erfolg |
| Warnung | \`--live\` | \`#b8841f\` | Hinweis |
| Fehler | \`--danger\` | \`#c5544a\` | Fehler |
| Navigation | \`--nav-*\` | \`--nav-bg: #14301f\` | nur Seitenleiste |

## Typografie

| Familie | Token | Einsatz |
|---|---|---|
| Space Grotesk | \`--font-display\` | Seitentitel |
| Inter | \`--font-body\` | Fließtext, UI (Basis 15px) |
| JetBrains Mono | \`--font-mono\` | Zahlen, SKUs |

## Form

- Radien: \`--r-sm\` 8px (Knöpfe), \`--r-md\` 12px (Karten)

## Komponenten

- **Primärknopf:** \`background: var(--go)\`, Text \`#fff\`
`);
    assert.equal(r.theme.colors.background, "#fafaf8");
    assert.equal(r.theme.colors.surface, "#ffffff");
    assert.equal(r.theme.colors.line, "#e7e8e3");
    assert.equal(r.theme.colors.text, "#1a1d1a", "the role column wins over later token names");
    assert.equal(r.theme.colors.accent, "#2d5b8a", "an accent row is not skipped because its description says Erfolg");
    assert.equal(r.theme.colors.primary, "#2d5b8a", "var(--go) resolves to the token value");
    assert.equal(r.theme.colors.primaryText, "#ffffff");
    assert.equal(r.theme.colors.muted, undefined);
    assert.ok(!Object.values(r.theme.colors).includes("#14301f"), "navigation colour is not the page background");
    assert.match(r.theme.fonts.sans ?? "", /^"Inter"/);
    assert.match(r.theme.fonts.mono ?? "", /JetBrains Mono/);
    assert.equal(r.theme.radius, 8);
  });
});
