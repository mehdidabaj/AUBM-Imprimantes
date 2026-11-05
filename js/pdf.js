/** PDF A4 paysage, police standard, texte en WinAnsi (accents français). */

import { EXPORT_HEADERS, exportCells } from "./logic.js";

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 32;

function encodeText(value) {
  const text = String(value ?? "")
    .replaceAll("œ", "oe")
    .replaceAll("Œ", "OE")
    .replaceAll("’", "'")
    .replaceAll("–", "-")
    .replaceAll("—", "-");
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) bytes.push(code);
    else bytes.push(63);
  }
  return bytes;
}

function escapeBytes(bytes) {
  const out = [];
  for (const byte of bytes) {
    if (byte === 40 || byte === 41 || byte === 92) out.push(92, byte);
    else out.push(byte);
  }
  return out;
}

function textWidth(value, size) {
  let width = 0;
  for (const ch of String(value ?? "")) {
    if (ch === " ") width += 0.33;
    else if (/[A-Z0-9%MWmw]/.test(ch)) width += 0.68;
    else width += 0.5;
  }
  return width * size;
}

function wrap(value, size, maxWidth) {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= maxWidth) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(value) {
  return Uint8Array.from(value, (ch) => ch.charCodeAt(0));
}

function latin(bytes) {
  return Uint8Array.from(bytes);
}

const COLS = [
  [EXPORT_HEADERS[0], 112],
  [EXPORT_HEADERS[1], 148],
  [EXPORT_HEADERS[2], 86],
  [EXPORT_HEADERS[3], 176],
  [EXPORT_HEADERS[4], 108],
  [EXPORT_HEADERS[5], 100],
  [EXPORT_HEADERS[6], 48],
];

export function buildPdf(printers, meta = {}) {
  const size = 8;
  const leading = 10;
  const header = layoutPages(printers, size, leading);
  return renderPdf(header.pages, meta);
}

function layoutPages(printers, size, leading) {
  const pages = [];
  let rows = [];
  let used = 0;
  const contentTop = PAGE_H - MARGIN - 48;
  const contentBottom = MARGIN + 24;
  const room = () => contentTop - contentBottom - used;

  const pushPage = () => {
    pages.push(rows);
    rows = [];
    used = 0;
  };

  for (const printer of printers) {
    const values = exportCells(printer);
    const cells = COLS.map(([, width], index) => wrap(values[index], size, width - 8));
    const height = Math.max(...cells.map((lines) => lines.length)) * leading + 8;
    if (rows.length && height > room()) pushPage();
    rows.push({ cells, height });
    used += height;
  }
  if (!rows.length) rows.push({ cells: COLS.map(() => ["Aucune machine."]), height: leading + 8 });
  pages.push(rows);
  return { pages };
}

function pageStream(rows, meta, pageIndex, pageCount) {
  const commands = [];
  const text = (font, size, x, y, value) => {
    const bytes = escapeBytes(encodeText(value));
    commands.push(`BT /F${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (`);
    commands.push(bytes);
    commands.push(") Tj ET\n");
  };
  commands.push("0.96 0.95 0.93 rg\n");
  commands.push(`${MARGIN} ${PAGE_H - MARGIN - 28} ${PAGE_W - MARGIN * 2} 28 re f\n`);
  commands.push("0.12 0.13 0.15 rg\n");
  const title = meta.title || "État des consommables des imprimantes de l'AUBM";
  text(2, 12, MARGIN + 8, PAGE_H - MARGIN - 18, title);
  if (meta.subtitle) {
    const subtitleWidth = textWidth(meta.subtitle, 8);
    text(1, 8, PAGE_W - MARGIN - 8 - subtitleWidth, PAGE_H - MARGIN - 16, meta.subtitle);
  }

  let y = PAGE_H - MARGIN - 48;
  let x = MARGIN;
  commands.push("0.17 0.19 0.22 rg\n");
  commands.push(`${MARGIN} ${y - 14} ${PAGE_W - MARGIN * 2} 16 re f\n`);
  commands.push("1 1 1 rg\n");
  for (const [label, width] of COLS) {
    text(2, 8, x + 4, y - 10, label);
    x += width;
  }
  y -= 16;
  commands.push("0.12 0.13 0.15 rg\n");
  rows.forEach((row, index) => {
    if (index % 2 === 0) {
      commands.push("0.97 0.96 0.94 rg\n");
      commands.push(`${MARGIN} ${y - row.height} ${PAGE_W - MARGIN * 2} ${row.height} re f\n`);
      commands.push("0.12 0.13 0.15 rg\n");
    }
    x = MARGIN;
    row.cells.forEach((lines, col) => {
      lines.forEach((line, lineIndex) => {
        text(1, 8, x + 4, y - 12 - lineIndex * 10, line);
      });
      x += COLS[col][1];
    });
    y -= row.height;
  });
  text(1, 8, PAGE_W - MARGIN - 70, MARGIN - 4, `Page ${pageIndex + 1} / ${pageCount}`);
  const chunks = commands.map((part) => (typeof part === "string" ? ascii(part) : latin(part)));
  return concat(chunks);
}

function renderPdf(pages, meta) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  add(ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  const pagesId = add(ascii("<< >>"));
  const fontRegular = add(ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  const fontBold = add(ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
  const pageIds = [];
  for (let index = 0; index < pages.length; index += 1) {
    const stream = pageStream(pages[index], meta, index, pages.length);
    const contentId = add(concat([
      ascii(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      ascii("\nendstream"),
    ]));
    const pageId = add(ascii(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> `
      + `/Contents ${contentId} 0 R >>`,
    ));
    pageIds.push(pageId);
  }
  objects[pagesId - 1] = ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);

  const chunks = [ascii("%PDF-1.4\n")];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const head = ascii(`${index + 1} 0 obj\n`);
    const tail = ascii("\nendobj\n");
    chunks.push(head, body, tail);
    position += head.length + body.length + tail.length;
  });
  const xrefAt = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  chunks.push(ascii(xref));
  return concat(chunks);
}
