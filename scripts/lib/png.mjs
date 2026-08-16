// Minimal PNG/ICO writers. No dependencies: the placeholder assets are
// generated at build time so the repo stays free of binary blobs that nobody
// can review.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {{width:number,height:number,rgba:Uint8Array}} img */
export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12: compression, filter, interlace — all 0.

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Classic BMP-backed ICO. PNG-compressed ICO entries are only understood by
 * newer tooling; the uncompressed DIB variant is accepted everywhere,
 * including the resource compiler that stamps the icon into the .exe.
 * @param {{width:number,height:number,rgba:Uint8Array}[]} images
 */
export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const payloads = [];
  let offset = 6 + images.length * 16;

  for (const { width, height, rgba } of images) {
    const dib = Buffer.alloc(40);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(width, 4);
    dib.writeInt32LE(height * 2, 8); // XOR + AND mask stacked
    dib.writeUInt16LE(1, 12); // planes
    dib.writeUInt16LE(32, 14); // bits per pixel

    // BMP rows run bottom-up and store BGRA.
    const xor = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const src = (height - 1 - y) * width * 4;
      const dst = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        xor[dst + x * 4 + 0] = rgba[src + x * 4 + 2];
        xor[dst + x * 4 + 1] = rgba[src + x * 4 + 1];
        xor[dst + x * 4 + 2] = rgba[src + x * 4 + 0];
        xor[dst + x * 4 + 3] = rgba[src + x * 4 + 3];
      }
    }
    // AND mask: unused for 32bpp icons, but the row-padded block must exist.
    const maskStride = Math.ceil(width / 32) * 4;
    const and = Buffer.alloc(maskStride * height);

    const payload = Buffer.concat([dib, xor, and]);
    const entry = Buffer.alloc(16);
    entry[0] = width >= 256 ? 0 : width;
    entry[1] = height >= 256 ? 0 : height;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(payload.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += payload.length;

    entries.push(entry);
    payloads.push(payload);
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

/**
 * Rasterises a shape described by a signed "inside" predicate with 3x3
 * supersampling, so the placeholder has soft edges to test the alpha hit mask
 * against.
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>{r:number,g:number,b:number}|null} sample
 */
export function raster(width, height, sample) {
  const rgba = new Uint8Array(width * height * 4);
  const SS = 3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hits = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const c = sample(px, py);
          if (c) {
            hits += 1;
            r += c.r;
            g += c.g;
            b += c.b;
          }
        }
      }
      const i = (y * width + x) * 4;
      if (hits === 0) continue;
      rgba[i + 0] = Math.round(r / hits);
      rgba[i + 1] = Math.round(g / hits);
      rgba[i + 2] = Math.round(b / hits);
      rgba[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return rgba;
}
