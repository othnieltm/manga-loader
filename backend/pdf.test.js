const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { createPdf } = require('./pdf');

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function createPng(colorType, scanline, chunks = [], width = 2, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const imageData = [];
  for (let row = 0; row < height; row += 1) {
    imageData.push(0, ...scanline);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    ...chunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.from(imageData))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('creates a valid multi-page PDF with correct cross-reference offsets', () => {
  const page = createPng(2, [255, 0, 0, 0, 255, 0]);
  const pdf = createPdf('Test Chapter', 'https://tcbonepiecechapters.com/chapters/1/test', [page, page]);
  const text = pdf.toString('latin1');
  const xrefOffset = Number(text.match(/startxref\n(\d+)\n/)?.[1]);

  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/Title \(Test Chapter\)/);
  assert.ok(Number.isInteger(xrefOffset));
  assert.equal(pdf.subarray(xrefOffset, xrefOffset + 4).toString(), 'xref');
});

test('uses landscape A4 pages for wide images and portrait A4 for tall images', () => {
  const landscapePage = createPng(2, [255, 0, 0, 0, 255, 0], [], 2, 1);
  const portraitPage = createPng(2, [255, 0, 0, 0, 255, 0], [], 1, 2);
  const pdf = createPdf('Mixed Orientation', 'https://example.test/chapter', [landscapePage, portraitPage]);
  const mediaBoxes = [...pdf.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];

  assert.deepEqual(mediaBoxes.map((match) => [Number(match[1]), Number(match[2])]), [
    [841.89, 595.28],
    [595.28, 841.89],
  ]);
});

test('embeds a soft mask for transparent PNG pages', () => {
  const page = createPng(6, [255, 0, 0, 255, 0, 255, 0, 128]);
  const pdf = createPdf('Transparent Chapter', 'https://example.test/chapter', [page]);
  assert.match(pdf.toString('latin1'), /\/SMask \d+ 0 R/);
});

test('decodes indexed PNG pages using their color palette', () => {
  const palette = pngChunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0]));
  const page = createPng(3, [0, 1], [palette]);
  const pdf = createPdf('Indexed Chapter', 'https://example.test/chapter', [page]);
  assert.match(pdf.toString('latin1'), /\/Subtype \/Image/);
});

test('rejects interlaced PNG pages with a useful error', () => {
  const page = createPng(2, [0, 0, 0, 0, 0, 0]);
  page[28] = 1;
  assert.throws(
    () => createPdf('Unsupported Chapter', 'https://example.test/chapter', [page]),
    /Only non-interlaced 8-bit PNG/,
  );
});