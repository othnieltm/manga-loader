const zlib = require('node:zlib');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG chapter page.');
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const data = [];

  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error('Truncated PNG chapter page.');
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      depth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === 'PLTE') {
      palette = buffer.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = buffer.subarray(start, end);
    } else if (type === 'IDAT') {
      data.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (!width || !height || depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) {
    throw new Error('Only non-interlaced 8-bit PNG chapter pages are supported.');
  }

  if (colorType === 3 && (!palette || palette.length === 0 || palette.length % 3 !== 0)) {
    throw new Error('The indexed PNG chapter page has an invalid palette.');
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const stride = width * channels;
  const filtered = zlib.inflateSync(Buffer.concat(data));
  const decoded = Buffer.alloc(stride * height);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[input++];
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = filtered[input++];
      const left = x >= channels ? decoded[row + x - channels] : 0;
      const up = y > 0 ? decoded[row + x - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[row + x - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error('Unsupported PNG filter in chapter page.');
      decoded[row + x] = (value + predictor) & 0xff;
    }
  }

  if (colorType === 2) {
    return { width, height, color: zlib.deflateSync(decoded), alpha: null, jpeg: false };
  }
  if (colorType === 0) {
    const rgb = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const target = pixel * 3;
      rgb[target] = decoded[pixel];
      rgb[target + 1] = decoded[pixel];
      rgb[target + 2] = decoded[pixel];
    }
    return { width, height, color: zlib.deflateSync(rgb), alpha: null, jpeg: false };
  }

  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 3;
    if (colorType === 3) {
      const paletteIndex = decoded[pixel];
      const paletteOffset = paletteIndex * 3;
      if (paletteOffset + 2 >= palette.length) throw new Error('The PNG palette index is out of range.');
      rgb[target] = palette[paletteOffset];
      rgb[target + 1] = palette[paletteOffset + 1];
      rgb[target + 2] = palette[paletteOffset + 2];
      alpha[pixel] = transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
    } else if (colorType === 4) {
      rgb[target] = decoded[source];
      rgb[target + 1] = decoded[source];
      rgb[target + 2] = decoded[source];
      alpha[pixel] = decoded[source + 1];
    } else {
      rgb[target] = decoded[source];
      rgb[target + 1] = decoded[source + 1];
      rgb[target + 2] = decoded[source + 2];
      alpha[pixel] = decoded[source + 3];
    }
  }

  const hasAlpha = colorType === 6 || colorType === 4 ||
    (colorType === 3 && transparency !== null);
  return {
    width,
    height,
    color: zlib.deflateSync(rgb),
    alpha: hasAlpha ? zlib.deflateSync(alpha) : null,
    jpeg: false,
  };
}

function jpegDimensions(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Invalid JPEG chapter page.');
  for (let offset = 2; offset + 9 < buffer.length;) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if ([0xd8, 0xd9, 0x01, ...Array.from({ length: 8 }, (_, i) => 0xd0 + i)].includes(marker)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error('Unable to read JPEG chapter page dimensions.');
}

function pdfString(value) {
  return String(value).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
}

function createPdf(title, sourceUrl, imageBuffers) {
  if (!imageBuffers.length || imageBuffers.length > 80) {
    throw new Error('PDF export requires between 1 and 80 chapter pages.');
  }
  const objects = [null, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), null];
  const kids = [];

  imageBuffers.forEach((buffer, index) => {
    const isPng = buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    const image = isPng
      ? decodePng(buffer)
      : { ...jpegDimensions(buffer), color: buffer, alpha: null, jpeg: true };
    const pageObject = 3 + index * 4;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const alphaObject = pageObject + 3;
    const landscape = image.width > image.height;
    const pageWidth = landscape ? PAGE_HEIGHT : PAGE_WIDTH;
    const pageHeight = landscape ? PAGE_WIDTH : PAGE_HEIGHT;
    const scale = Math.min((pageWidth - 40) / image.width, (pageHeight - 40) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = (pageWidth - width) / 2;
    const y = (pageHeight - height) / 2;
    kids.push(`${pageObject} 0 R`);
    objects[pageObject] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    const content = Buffer.from(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
    objects[contentObject] = Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ]);
    const filter = image.jpeg ? '/DCTDecode' : '/FlateDecode';
    const mask = image.alpha ? ` /SMask ${alphaObject} 0 R` : '';
    objects[imageObject] = Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter}${mask} /Length ${image.color.length} >>\nstream\n`,
      ),
      image.color,
      Buffer.from('\nendstream'),
    ]);
    objects[alphaObject] = image.alpha
      ? Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>\nstream\n`,
        ),
        image.alpha,
        Buffer.from('\nendstream'),
      ])
      : Buffer.from('<< >>');
  });

  objects[2] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`);
  const infoObject = objects.length;
  objects.push(Buffer.from(`<< /Title (${pdfString(title)}) /Subject (Chapter page capture) /Keywords (${pdfString(sourceUrl)}) >>`));
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = length;
    const chunk = Buffer.concat([Buffer.from(`${i} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const entries = ['0000000000 65535 f '];
  for (let i = 1; i < objects.length; i += 1) {
    entries.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  }
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length}\n${entries.join('\n')}\n` +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoObject} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`,
  ));
  return Buffer.concat(chunks);
}

module.exports = { createPdf };