/* 아이콘(assets/icon.ico) 생성 — 외부 라이브러리 없이.
 *
 * 4배로 크게 그린 뒤 줄여서 가장자리를 부드럽게 만든다.
 * 결과는 여러 크기(16~256)를 담은 ICO 한 개.
 *
 * 그림: 파란 바탕에 답안지 한 장. 보기 동그라미가 줄지어 있고
 *       그중 하나가 칠해져 있으며, 오른쪽 아래에 초록 체크가 붙는다.
 *       ("AI 가 답을 골라 맞혔다" 는 뜻)
 *
 * 작은 크기(16·24px)에서는 동그라미가 뭉개져 얼룩이 되므로,
 * 그때는 줄 수를 줄이고 굵게 그린다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'assets', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;                       // 안티에일리어싱용 확대 배율

/* ── 아주 작은 그리기 도구 ─────────────────────────────────────────── */

function canvas(w, h) {
  return { w, h, px: new Uint8ClampedArray(w * h * 4) };
}

function blend(c, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 4;
  const sa = a / 255;
  c.px[i] = c.px[i] * (1 - sa) + r * sa;
  c.px[i + 1] = c.px[i + 1] * (1 - sa) + g * sa;
  c.px[i + 2] = c.px[i + 2] * (1 - sa) + b * sa;
  c.px[i + 3] = Math.min(255, c.px[i + 3] + a * (1 - c.px[i + 3] / 255));
}

function rect(c, x0, y0, w, h, color) {
  for (let y = Math.floor(y0); y < y0 + h; y++) {
    for (let x = Math.floor(x0); x < x0 + w; x++) blend(c, x, y, color);
  }
}

function roundRect(c, x0, y0, w, h, r, color) {
  for (let y = Math.floor(y0); y < y0 + h; y++) {
    for (let x = Math.floor(x0); x < x0 + w; x++) {
      const dx = Math.max(x0 + r - x, x - (x0 + w - 1 - r), 0);
      const dy = Math.max(y0 + r - y, y - (y0 + h - 1 - r), 0);
      if (dx * dx + dy * dy <= r * r) blend(c, x, y, color);
    }
  }
}

/** 속이 빈 동그라미 (고르지 않은 보기) */
function ring(c, cx, cy, r, t, color) {
  const outer = r * r, inner = (r - t) * (r - t);
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d <= outer && d >= inner) blend(c, x, y, color);
    }
  }
}

/** 꽉 찬 동그라미 (고른 보기) */
function disc(c, cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) blend(c, x, y, color);
    }
  }
}

/** 굵은 선분 — 체크 표시를 그리는 데 쓴다 */
function stroke(c, x1, y1, x2, y2, t, color) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let i = 0; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    disc(c, x, y, t / 2, color);
  }
}

/* ── 아이콘 그림 ───────────────────────────────────────────────────── */

function draw(size) {
  const S = size * SS;
  const c = canvas(S, S);
  const u = S / 256;                 // 256 기준으로 좌표를 잡는다
  const small = size <= 24;          // 작을 때는 단순하게

  const BLUE = [59, 108, 246, 255];
  const WHITE = [255, 255, 255, 255];
  const PAPER = [255, 255, 255, 255];
  const FAINT = [59, 108, 246, 90];
  const OK = [23, 166, 115, 255];

  roundRect(c, 8 * u, 8 * u, 240 * u, 240 * u, 54 * u, BLUE);

  /* 답안지 */
  roundRect(c, 44 * u, 40 * u, 168 * u, 176 * u, 16 * u, PAPER);

  if (small) {
    /* 작을 때: 굵은 줄 두 개 + 큰 체크 하나 */
    rect(c, 66 * u, 74 * u, 78 * u, 16 * u, FAINT);
    rect(c, 66 * u, 108 * u, 60 * u, 16 * u, FAINT);
    stroke(c, 78 * u, 168 * u, 108 * u, 196 * u, 26 * u, OK);
    stroke(c, 108 * u, 196 * u, 176 * u, 128 * u, 26 * u, OK);
    return downsample(c, size);
  }

  /* 보기 줄 세 개 — 각 줄은 [문제 줄] + 동그라미 넷 */
  const rows = [
    { y: 74, picked: 1, barW: 52 },
    { y: 112, picked: 3, barW: 68 },
    { y: 150, picked: 0, barW: 44 },
  ];
  for (const row of rows) {
    rect(c, 64 * u, (row.y - 5) * u, row.barW * u, 9 * u, FAINT);
    for (let i = 0; i < 4; i++) {
      const cx = (76 + i * 30) * u;
      const cy = (row.y + 22) * u;
      if (i === row.picked) disc(c, cx, cy, 10 * u, BLUE);
      else ring(c, cx, cy, 10 * u, 3.5 * u, FAINT);
    }
  }

  /* 맞았다는 초록 체크 — 종이 오른쪽 아래에 걸치게 */
  disc(c, 196 * u, 196 * u, 42 * u, [255, 255, 255, 255]);
  disc(c, 196 * u, 196 * u, 36 * u, OK);
  stroke(c, 178 * u, 197 * u, 191 * u, 210 * u, 11 * u, WHITE);
  stroke(c, 191 * u, 210 * u, 215 * u, 183 * u, 11 * u, WHITE);

  return downsample(c, size);
}

function downsample(c, size) {
  const out = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * c.w + (x * SS + dx)) * 4;
          r += c.px[i]; g += c.px[i + 1]; b += c.px[i + 2]; a += c.px[i + 3];
        }
      }
      const n = SS * SS, o = (y * size + x) * 4;
      out.px[o] = r / n; out.px[o + 1] = g / n; out.px[o + 2] = b / n; out.px[o + 3] = a / n;
    }
  }
  return out;
}

/* ── PNG 쓰기 ──────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8;      // 채널당 8비트
  ihdr[9] = 6;      // RGBA
  const raw = Buffer.alloc((c.w * 4 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 4 + 1)] = 0;     // 필터 없음
    Buffer.from(c.px.buffer, y * c.w * 4, c.w * 4).copy(raw, y * (c.w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── ICO 묶기 ──────────────────────────────────────────────────────── */

function toIco(pngs) {
  const head = Buffer.alloc(6 + pngs.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);                 // 1 = 아이콘
  head.writeUInt16LE(pngs.length, 4);

  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;       // 256 은 0 으로 표기한다
    head[e + 1] = size >= 256 ? 0 : size;
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4);           // planes
    head.writeUInt16LE(32, e + 6);          // 32bpp
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/* ── 실행 ──────────────────────────────────────────────────────────── */

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const pngs = SIZES.map((size) => ({ size, data: toPng(draw(size)) }));
  fs.writeFileSync(OUT, toIco(pngs));
  console.log(`아이콘 생성: ${path.relative(__dirname, OUT)} (${SIZES.join('/')}px, ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  return OUT;
}

if (require.main === module) main();
module.exports = { main, OUT };
