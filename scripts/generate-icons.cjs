const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = process.cwd();
const assetsDir = path.join(root, 'assets');
const publicDir = path.join(root, 'public');
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

const png256 = renderIcon(256);
const png64 = renderIcon(64);
fs.writeFileSync(path.join(assetsDir, 'app-icon.png'), png256);
fs.writeFileSync(path.join(publicDir, 'app-icon.png'), png256);
fs.writeFileSync(path.join(assetsDir, 'app-icon.ico'), makeIco([png256, png64]));

console.log('Generated assets/app-icon.png, assets/app-icon.ico, public/app-icon.png');

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 256;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ux = x / scale;
      const uy = y / scale;
      const index = (y * size + x) * 4;
      const alpha = roundedRectAlpha(ux, uy, 0, 0, 256, 256, 54);
      const base = mix([16, 24, 32], [34, 78, 82], clamp((ux + uy) / 420, 0, 1));
      setPixel(pixels, index, base, alpha);
    }
  }

  drawWave(pixels, size, scale);
  drawCircle(pixels, size, scale, 76, 76, 23, [243, 91, 104, 255]);
  drawCircle(pixels, size, scale, 76, 76, 10, [255, 232, 233, 255]);
  drawTriangle(pixels, size, scale, [[105, 82], [105, 152], [184, 117]], [244, 193, 115, 255]);
  drawGlyph2K(pixels, size, scale);
  return encodePng(size, size, pixels);
}

function drawWave(pixels, size, scale) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ux = x / scale;
      const uy = y / scale;
      if (uy > 140 + 25 * Math.sin((ux - 10) / 38)) {
        blendPixel(pixels, size, x, y, [22, 57, 62, 210]);
      }
      if (Math.abs(uy - (129 + 38 * Math.sin((ux - 90) / 43))) < 13 && ux > 5 && ux < 246) {
        blendPixel(pixels, size, x, y, [119, 218, 209, 230]);
      }
    }
  }
}

function drawCircle(pixels, size, scale, cx, cy, r, rgba) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ux = x / scale;
      const uy = y / scale;
      const d = Math.hypot(ux - cx, uy - cy);
      if (d <= r) {
        const edge = clamp(r - d, 0, 1);
        blendPixel(pixels, size, x, y, [rgba[0], rgba[1], rgba[2], rgba[3] * edge]);
      }
    }
  }
}

function drawTriangle(pixels, size, scale, points, rgba) {
  const [[x1, y1], [x2, y2], [x3, y3]] = points;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ux = x / scale;
      const uy = y / scale;
      const a = sign(ux, uy, x1, y1, x2, y2);
      const b = sign(ux, uy, x2, y2, x3, y3);
      const c = sign(ux, uy, x3, y3, x1, y1);
      if (!((a < 0 || b < 0 || c < 0) && (a > 0 || b > 0 || c > 0))) {
        blendPixel(pixels, size, x, y, rgba);
      }
    }
  }
}

function drawGlyph2K(pixels, size, scale) {
  const color = [247, 251, 249, 255];
  const blocks = [
    [46, 150, 46, 14],
    [76, 164, 16, 34],
    [46, 181, 16, 17],
    [46, 198, 46, 14],
    [113, 150, 16, 62],
    [129, 178, 15, 16],
    [146, 150, 18, 18],
    [146, 194, 18, 18]
  ];
  for (const [x, y, w, h] of blocks) {
    drawRect(pixels, size, scale, x, y, w, h, color);
  }
}

function drawRect(pixels, size, scale, x, y, w, h, rgba) {
  const sx = Math.floor(x * scale);
  const sy = Math.floor(y * scale);
  const ex = Math.ceil((x + w) * scale);
  const ey = Math.ceil((y + h) * scale);
  for (let py = sy; py < ey; py += 1) {
    for (let px = sx; px < ex; px += 1) {
      if (px >= 0 && px < size && py >= 0 && py < size) {
        blendPixel(pixels, size, px, py, rgba);
      }
    }
  }
}

function setPixel(pixels, index, rgb, alpha) {
  pixels[index] = rgb[0];
  pixels[index + 1] = rgb[1];
  pixels[index + 2] = rgb[2];
  pixels[index + 3] = Math.round(255 * alpha);
}

function blendPixel(pixels, size, x, y, rgba) {
  const index = (y * size + x) * 4;
  const sourceAlpha = rgba[3] / 255;
  const destAlpha = pixels[index + 3] / 255;
  const outputAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) {
    return;
  }
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[index + channel] = Math.round(
      (rgba[channel] * sourceAlpha + pixels[index + channel] * destAlpha * (1 - sourceAlpha)) /
        outputAlpha
    );
  }
  pixels[index + 3] = Math.round(outputAlpha * 255);
}

function roundedRectAlpha(x, y, left, top, width, height, radius) {
  const cx = clamp(x, left + radius, left + width - radius);
  const cy = clamp(y, top + radius, top + height - radius);
  const dist = Math.hypot(x - cx, y - cy);
  return clamp(radius - dist + 1, 0, 1);
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function sign(px, py, x1, y1, x2, y2) {
  return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function encodePng(width, height, rgba) {
  const chunks = [];
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  chunks.push(chunk('IHDR', concatUInt32(width, height, Buffer.from([8, 6, 0, 0, 0]))));
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const size = readPngSize(image);
    const entry = Buffer.alloc(16);
    entry[0] = size.width >= 256 ? 0 : size.width;
    entry[1] = size.height >= 256 ? 0 : size.height;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.length;
  }
  return Buffer.concat([header, ...entries, ...images]);
}

function readPngSize(buffer) {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function concatUInt32(width, height, rest) {
  const buffer = Buffer.alloc(8 + rest.length);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  rest.copy(buffer, 8);
  return buffer;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
