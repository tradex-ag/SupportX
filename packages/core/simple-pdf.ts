/**
 * A small text-only PDF writer (A4, Helvetica, WinAnsi), no dependencies. Enough for
 * an evidence document: headings, label/value lines and wrapped paragraphs.
 */
export type PdfBlock =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "space" };

const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;

// Characters of CP1252 that differ from Latin-1 (subset that matters in German text).
const CP1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "›": 0x9b, "‹": 0x8b };

/** Encodes to WinAnsi bytes and escapes for a PDF string; unknown characters become "?". */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = CP1252[ch] ?? ch.codePointAt(0)!;
    const byte = code <= 0xff && !(code >= 0x80 && code < 0xa0 && !CP1252[ch]) ? code : 0x3f;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20) out += " ";
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** Wraps at word boundaries with an average-width estimate for Helvetica. */
export function wrap(text: string, size: number, width = PAGE_W - 2 * MARGIN): string[] {
  const max = Math.max(10, Math.floor(width / (size * 0.52)));
  const lines: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (word.length > max) {
        if (line) lines.push(line);
        for (let i = 0; i < word.length; i += max) lines.push(word.slice(i, i + max));
        line = lines.pop()!;
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > max) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export function renderPdf(blocks: ReadonlyArray<PdfBlock>, footer: string): Buffer {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const put = (font: "F1" | "F2", size: number, text: string, gray = 0) => {
    if (y - size < MARGIN + 20) {
      pages.push([]);
      y = PAGE_H - MARGIN;
    }
    y -= size * 1.35;
    pages.at(-1)!.push(`${gray} g BT /${font} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${pdfString(text)}) Tj ET`);
  };
  for (const b of blocks) {
    if (b.kind === "space") y -= 8;
    else if (b.kind === "title") for (const l of wrap(b.text, 16)) put("F2", 16, l);
    else if (b.kind === "heading") {
      y -= 6;
      for (const l of wrap(b.text, 11.5)) put("F2", 11.5, l);
    } else for (const l of wrap(b.text, 9.5)) put("F1", 9.5, l, b.muted ? 0.4 : 0);
  }

  const objects: string[] = [];
  const add = (body: string) => objects.push(body) ;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages, filled below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  pages.forEach((ops, i) => {
    const foot = `0.4 g BT /F1 8 Tf ${MARGIN} 30 Td (${pdfString(`${footer} · Seite ${i + 1} von ${pages.length}`)}) Tj ET`;
    const stream = [...ops, foot].join("\n");
    add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const contentId = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(objects.length);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
