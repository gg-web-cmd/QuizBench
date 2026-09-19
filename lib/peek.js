/* 문서 안을 살짝 들여다보기 — 파일 이름만으로 알 수 없을 때만 쓴다.
 *
 * 바깥 라이브러리 없이 Node 기본 기능(zlib)만으로 처리한다.
 *   hwpx·docx·pptx·xlsx·odt  zip 안의 본문 XML 을 풀어 글자만 남긴다
 *   hwp                      OLE 컨테이너 안의 미리보기 글(PrvText)을 꺼낸다
 *   pdf                      스트림을 풀어 글자를 긁어 온다 (되는 만큼만)
 *   txt·md·csv 등            그대로 읽는다 (UTF-8 / EUC-KR 자동 판별)
 *
 * 어떤 이유로든 실패하면 빈 문자열이다. 판단이 조금 둔해질 뿐, 정리는 계속된다.
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

/* 문서정리기에서는 6000자면 분류에 충분했지만, 여기서는 **문제를 풀려면**
 * 문제지 전체가 있어야 한다. 그래서 넉넉히 늘렸다. */
const MAX_CHARS = 200000;
const MAX_FILE = 60 * 1024 * 1024;
const MAX_INFLATE = 8 * 1024 * 1024;

/* ── 글자 다루기 ───────────────────────────────────────────────────── */

let eucKr = null;
let eucKrTried = false;
function decodeEucKr(buf) {
  if (!eucKrTried) {
    eucKrTried = true;
    try { eucKr = new TextDecoder('euc-kr'); } catch (_) { eucKr = null; }
  }
  return eucKr ? eucKr.decode(buf) : '';
}

/** BOM·깨짐 여부를 보고 UTF-8 / UTF-16 / EUC-KR 을 알아서 고른다 */
function decode(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const even = body.length % 2 ? body.subarray(0, body.length - 1) : body;   // swap16 은 짝수만 받는다
    const swapped = Buffer.from(even);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);

  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0) return utf8;
  const legacy = decodeEucKr(buf);
  if (!legacy) return utf8;
  const legacyBad = (legacy.match(/�/g) || []).length;
  return legacyBad < bad ? legacy : utf8;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** XML → 글자만. 태그 자리에는 공백을 넣어 단어가 붙지 않게 한다. */
function stripXml(s) {
  return s
    .replace(/<\/(?:w:p|w:tab|a:p|text:p|hp:p|hp:linebreak)>/gi, ' \n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] || ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

function readUpTo(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

/* ── zip 안에서 필요한 것만 꺼내기 ─────────────────────────────────── */

/**
 * 압축 목록을 훑어 want(name) 이 참인 항목만 풀어 준다.
 * 스트리밍 라이브러리 없이 중앙 디렉터리를 직접 읽는다. (ZIP64 는 건너뛴다)
 */
function readZip(file, want, maxEntries = 12) {
  const out = [];
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return out; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) return out;

    const tailLen = Math.min(size, 66000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return out;

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff || cdSize > 8 * 1024 * 1024) return out;
    if (cdOff + cdSize > size) return out;

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;

      if (!want(name)) continue;
      if (compSize === 0 || compSize > MAX_INFLATE) continue;
      if (localOff + 30 > size) continue;

      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const dataAt = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (dataAt + compSize > size) continue;

      const raw = Buffer.alloc(compSize);
      fs.readSync(fd, raw, 0, compSize, dataAt);

      let data = null;
      if (method === 0) data = raw;
      else if (method === 8) {
        try { data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_INFLATE }); } catch (_) { data = null; }
      }
      if (!data) continue;

      out.push({ name, data });
      if (out.length >= maxEntries) break;
    }
  } catch (_) { /* 못 읽으면 없는 것으로 */ }
  finally { try { fs.closeSync(fd); } catch (_) {} }
  return out;
}

/* ── OLE(hwp) 안에서 미리보기 글 꺼내기 ────────────────────────────── */

const CFB_SIG = 'd0cf11e0a1b11ae1';
const FREE = 0xffffffff;
const END = 0xfffffffe;

/** hwp(HWP 5.0) 는 OLE 컨테이너다. 그 안의 PrvText 스트림이 사람이 읽는 미리보기 글이다. */
function cfbStream(file, wantName) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 1536) return null;

    const hdr = Buffer.alloc(512);
    fs.readSync(fd, hdr, 0, 512, 0);
    if (hdr.toString('hex', 0, 8) !== CFB_SIG) return null;

    const secSize = 1 << hdr.readUInt16LE(0x1e);
    const miniSize = 1 << hdr.readUInt16LE(0x20);
    if (secSize < 128 || secSize > 65536 || miniSize < 16) return null;
    const numFat = hdr.readUInt32LE(0x2c);
    const dirStart = hdr.readUInt32LE(0x30);
    const cutoff = hdr.readUInt32LE(0x38) || 4096;
    const miniFatStart = hdr.readUInt32LE(0x3c);
    let difat = hdr.readUInt32LE(0x44);

    const sector = (id) => {
      const off = (id + 1) * secSize;
      if (id > 0xfffffff0 || off + secSize > size) return null;
      const b = Buffer.alloc(secSize);
      fs.readSync(fd, b, 0, secSize, off);
      return b;
    };

    /* FAT 이 어느 섹터들에 흩어져 있는지 모은다 */
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
      const s = hdr.readUInt32LE(0x4c + i * 4);
      if (s === FREE || s === END) break;
      fatSectors.push(s);
    }
    let guard = 0;
    while (difat !== FREE && difat !== END && fatSectors.length < numFat && guard++ < 512) {
      const b = sector(difat);
      if (!b) break;
      const per = secSize / 4 - 1;
      for (let i = 0; i < per && fatSectors.length < numFat; i++) {
        const s = b.readUInt32LE(i * 4);
        if (s !== FREE && s !== END) fatSectors.push(s);
      }
      difat = b.readUInt32LE(secSize - 4);
    }

    const fat = [];
    for (const fsec of fatSectors) {
      const b = sector(fsec);
      if (!b) break;
      for (let i = 0; i < secSize / 4; i++) fat.push(b.readUInt32LE(i * 4));
    }
    if (!fat.length) return null;

    const chain = (start, max = 65536) => {
      const list = [];
      let c = start, g = 0;
      while (c !== END && c !== FREE && c < fat.length && g++ < max) { list.push(c); c = fat[c]; }
      return list;
    };
    const readChain = (start, bytes) => {
      const parts = [];
      let got = 0;
      for (const s of chain(start)) {
        const b = sector(s);
        if (!b) break;
        parts.push(b);
        got += secSize;
        if (bytes && got >= bytes) break;
        if (got > MAX_INFLATE) break;
      }
      const all = Buffer.concat(parts);
      return bytes && bytes < all.length ? all.subarray(0, bytes) : all;
    };

    /* 디렉터리에서 이름으로 스트림을 찾는다 */
    const dir = readChain(dirStart);
    let root = null, target = null;
    for (let p = 0; p + 128 <= dir.length; p += 128) {
      const nameLen = dir.readUInt16LE(p + 0x40);
      const type = dir[p + 0x42];
      if (!nameLen || nameLen > 64 || (type !== 2 && type !== 5)) continue;
      const name = dir.toString('utf16le', p, p + nameLen - 2).replace(/\0+$/, '');
      const entry = {
        name,
        start: dir.readUInt32LE(p + 0x74),
        size: Number(dir.readBigUInt64LE(p + 0x78)),
      };
      if (type === 5) root = entry;
      else if (name === wantName) target = entry;
    }
    if (!target || !target.size) return null;
    if (target.size > MAX_INFLATE) target.size = MAX_INFLATE;

    /* 4KB 미만 스트림은 미니 스트림 안에 들어 있다 */
    if (target.size >= cutoff) return readChain(target.start, target.size);
    if (!root) return null;

    const miniStream = readChain(root.start, Math.min(root.size || MAX_INFLATE, MAX_INFLATE));
    const miniFatBuf = readChain(miniFatStart);
    const miniFat = [];
    for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) miniFat.push(miniFatBuf.readUInt32LE(i));

    const parts = [];
    let c = target.start, g = 0, got = 0;
    while (c !== END && c !== FREE && c < miniFat.length && g++ < 20000 && got < target.size) {
      const off = c * miniSize;
      if (off + miniSize > miniStream.length) break;
      parts.push(miniStream.subarray(off, off + miniSize));
      got += miniSize;
      c = miniFat[c];
    }
    return parts.length ? Buffer.concat(parts).subarray(0, target.size) : null;
  } catch (_) { return null; }
  finally { try { fs.closeSync(fd); } catch (_) {} }
}

/* ── pdf 에서 글자 긁기 (되는 만큼) ────────────────────────────────── */

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
    if (g === 'n') return ' ';
    if (g === 'r') return ' ';
    if (g === 't') return ' ';
    if (g === 'b' || g === 'f') return ' ';
    if (g === '(' || g === ')' || g === '\\') return g;
    const code = parseInt(g, 8);
    return code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
  });
}

/** 페이지 내용 스트림에서 보여 주는 글만 골라 낸다 */
function pdfOps(text) {
  let out = '';
  const re = /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < MAX_CHARS * 2) {
    const tok = m[0];
    if (tok[0] === '(') {
      out += unescapePdf(tok.slice(1, -1)) + ' ';
    } else {
      const hex = tok.slice(1, -1).replace(/\s+/g, '');
      if (hex.length < 4 || hex.length % 4 !== 0) continue;
      const buf = Buffer.from(hex, 'hex');
      buf.swap16();                                   // UTF-16BE → LE
      const s = buf.toString('utf16le');
      if (/[가-힣a-zA-Z]/.test(s)) out += s + ' ';
    }
  }
  return out;
}

/** 깨진 글자 뭉치를 규칙 판단에 쓰면 해가 되니, 사람이 읽을 만한지 본다 */
function pdfLooksReadable(s) {
  const hangul = (s.match(/[가-힣]/g) || []).length;
  if (hangul >= 6) return true;
  const clean = s.replace(/\s+/g, '');
  if (clean.length < 40) return false;
  const plain = (clean.match(/[A-Za-z0-9.,;:'"()\-]/g) || []).length;
  return plain / clean.length >= 0.9;
}

function pdfText(file) {
  const buf = readUpTo(file, 6 * 1024 * 1024);
  let out = '';
  let i = 0;
  const needle = Buffer.from('stream');
  const endNeedle = Buffer.from('endstream');

  while (out.length < MAX_CHARS) {
    i = buf.indexOf(needle, i);
    if (i === -1) break;
    let s = i + needle.length;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const e = buf.indexOf(endNeedle, s);
    i = e === -1 ? buf.length : e + endNeedle.length;
    if (e === -1) break;

    const chunk = buf.subarray(s, e);
    if (chunk.length < 16 || chunk.length > 3 * 1024 * 1024) continue;

    let data = null;
    if (chunk[0] === 0x78) {
      try { data = zlib.inflateSync(chunk, { maxOutputLength: MAX_INFLATE }); } catch (_) { data = null; }
    }
    if (!data) {
      const head = chunk.toString('latin1', 0, Math.min(600, chunk.length));
      if (/\bBT\b|\bTj\b|\bTJ\b/.test(head)) data = chunk;
    }
    if (!data) continue;

    const asText = data.toString('latin1');
    if (!/\bTj\b|\bTJ\b/.test(asText)) continue;
    out += pdfOps(asText);
  }

  out = out.replace(/[ \t]+/g, ' ').trim();
  return pdfLooksReadable(out) ? out : '';
}

/* ── 형식별 진입점 ─────────────────────────────────────────────────── */

const PLAIN = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'html', 'htm', 'rtf']);

const ZIP_WANT = {
  hwpx: (n) => n === 'Preview/PrvText.txt' || /^Contents\/section\d*\.xml$/i.test(n),
  docx: (n) => n === 'word/document.xml' || n === 'docProps/core.xml',
  pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n) || n === 'docProps/core.xml',
  xlsx: (n) => n === 'xl/sharedStrings.xml' || n === 'docProps/core.xml',
  odt: (n) => n === 'content.xml' || n === 'meta.xml',
  odp: (n) => n === 'content.xml' || n === 'meta.xml',
  ods: (n) => n === 'content.xml' || n === 'meta.xml',
  hwt: (n) => n === 'Preview/PrvText.txt' || /^Contents\/section\d*\.xml$/i.test(n),
};

/**
 * 문서에서 글자를 꺼낸다. 실패하면 빈 문자열.
 * @param {string} file  전체 경로
 * @param {string} ext   점 없는 소문자 확장자
 */
function peek(file, ext) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_FILE) return '';
  } catch (_) { return ''; }

  try {
    if (PLAIN.has(ext)) {
      let text = decode(readUpTo(file, 4 * 1024 * 1024));
      if (ext === 'rtf' || ext === 'html' || ext === 'htm' || ext === 'xml') text = stripXml(text.replace(/\\'[0-9a-f]{2}/gi, ' '));
      return text.slice(0, MAX_CHARS);
    }

    if (ZIP_WANT[ext]) {
      /* 긴 시험지는 구역(section)이 여럿이라 넉넉히 받는다 — 분류가 아니라 풀이가 목적이다 */
      const parts = readZip(file, ZIP_WANT[ext], 60);
      if (!parts.length) return '';
      parts.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      let text = '';
      for (const p of parts) {
        const raw = decode(p.data);
        text += (p.name.endsWith('.txt') ? raw : stripXml(raw)) + '\n';
        if (text.length > MAX_CHARS) break;
      }
      return text.slice(0, MAX_CHARS);
    }

    if (ext === 'hwp') {
      const prv = cfbStream(file, 'PrvText');
      if (prv && prv.length) {
        const text = prv.toString('utf16le').replace(/\0/g, ' ');
        if (/[가-힣a-zA-Z0-9]/.test(text)) return text.replace(/[ \t]+/g, ' ').slice(0, MAX_CHARS);
      }
      return '';
    }

    if (ext === 'pdf') return pdfText(file).slice(0, MAX_CHARS);
  } catch (_) { /* 못 읽으면 이름만으로 판단한다 */ }

  return '';
}

/** 이 형식은 안을 들여다볼 수 있는가 */
function canPeek(ext) {
  return PLAIN.has(ext) || !!ZIP_WANT[ext] || ext === 'hwp' || ext === 'pdf';
}

module.exports = { peek, canPeek, decode, stripXml, readZip, cfbStream, MAX_CHARS };
