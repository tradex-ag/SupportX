import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderPdf, wrap } from "../../packages/core/simple-pdf.ts";

describe("simple PDF", () => {
  it("wraps long text and splits words longer than a line", () => {
    const lines = wrap(`${"wort ".repeat(60)}${"x".repeat(250)}`, 10);
    assert.ok(lines.length > 4);
    assert.ok(lines.every((l) => l.length <= 99));
  });
  it("writes a valid structure with escaped brackets, umlauts and the euro sign", () => {
    const pdf = renderPdf([{ kind: "title", text: "Größe (40×40) \\ 5 €" }, ...Array.from({ length: 120 }, (_, i) => ({ kind: "text" as const, text: `Zeile ${i}` }))], "Fuß");
    const text = pdf.toString("latin1");
    assert.match(text, /Gr\xf6\xdfe \\\(40\xd740\\\) \\\\ 5 \x80/);
    assert.match(text, /\/Count 3 >>/);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    assert.equal(text.slice(xref, xref + 4), "xref");
    for (const m of text.matchAll(/^(\d{10}) 00000 n $/gm)) assert.match(text.slice(Number(m[1])), /^\d+ 0 obj/);
  });
});
