/* 실행 환경 차이 흡수.
 *
 * 이 도구는 두 가지 모습으로 돈다.
 *   개발 모드 : node server.js — 화면 파일과 도우미 소스를 디스크에서 읽는다
 *   exe 모드  : 단일 실행 파일(Node SEA) — 그 파일들이 exe 안에 박혀 있다
 *
 * 나머지 코드가 이 차이를 신경 쓰지 않도록 여기서만 갈라 준다.
 * (C:\vibe 의 다른 도구들과 같은 틀이다.)
 */
'use strict';
const fs = require('fs');
const path = require('path');

let sea = null;
try { sea = require('node:sea'); } catch (_) { /* 아주 옛 Node */ }

const IS_SEA = !!(sea && sea.isSea && sea.isSea());

/* exe 안에서는 실행 파일이 있는 폴더, 개발 중에는 프로젝트 폴더 */
const ROOT = IS_SEA ? path.dirname(process.execPath) : path.dirname(__dirname);
const DEV_ROOT = path.dirname(__dirname);

/* 브라우저에 내보내도 되는 화면 파일. (vendor\ 는 따로 다룬다 — 파일이 200개 가까이 된다) */
const WEB_FILES = ['/index.html', '/css/style.css', '/js/app.js', '/js/upload.js'];

/* 화면은 아니지만 exe 안에 함께 넣어야 하는 파일 — 창 캡처 도우미(C#) 소스 */
const NATIVE_FILES = ['/native/worker.cs'];

/** exe 안에 꼭 있어야 하는 pdf.js 알맹이 (없으면 PDF 를 한 쪽도 못 그린다) */
const VENDOR_MUST_HAVE = [
  '/vendor/pdf.min.mjs',
  '/vendor/pdf.worker.min.mjs',
  '/vendor/standard_fonts/LiberationSans-Regular.ttf',
];

function cleanKey(key) {
  return '/' + String(key).replace(/^[/\\]+/, '').split('\\').join('/');
}

/** 빌드할 때만 쓴다 — vendor\ 안의 모든 파일을 웹 경로 목록으로 */
function vendorFiles() {
  const base = path.join(DEV_ROOT, 'vendor');
  const out = [];
  const walk = (dir, prefix) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const web = prefix + '/' + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), web);
      else if (e.isFile()) out.push(web);
    }
  };
  walk(base, '/vendor');
  return out;
}

/** exe 안(또는 디스크)에서 파일 하나를 꺼낸다. 없으면 null. */
function asset(key, allowed) {
  const clean = cleanKey(key);
  if (allowed && !allowed.includes(clean)) return null;
  if (IS_SEA) {
    try {
      const raw = sea.getRawAsset(clean);
      return raw ? Buffer.from(raw) : null;
    } catch (_) { return null; }
  }
  try {
    /* 개발 모드에서도 프로젝트 폴더 밖은 절대 읽지 않는다 */
    const full = path.resolve(DEV_ROOT, '.' + clean);
    const inside = path.relative(DEV_ROOT, full);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
    return fs.readFileSync(full);
  } catch (_) { return null; }
}

/* vendor\ 아래에서 허용하는 이름 모양 — 여기 안 맞으면 아예 찾아보지 않는다 */
const VENDOR_OK = /^\/vendor\/(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;

/** 화면 자원(html·css·js·vendor). 키는 언제나 '/css/style.css' 처럼 웹 경로. */
function webAsset(key) {
  const clean = cleanKey(key);
  if (clean.includes('..')) return null;
  if (WEB_FILES.includes(clean)) return asset(clean, WEB_FILES);
  if (VENDOR_OK.test(clean)) return asset(clean, null);
  return null;
}

/** 도우미 C# 소스 글자. exe 모드에서도 그대로 나온다. */
function nativeSource() {
  const buf = asset('/native/worker.cs', NATIVE_FILES);
  if (!buf) return null;
  /* BOM 이 붙어 있으면 떼고 넘긴다(다시 붙여 저장하는 쪽에서 붙인다) */
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

module.exports = {
  IS_SEA, ROOT, DEV_ROOT,
  WEB_FILES, NATIVE_FILES, VENDOR_MUST_HAVE,
  vendorFiles, webAsset, nativeSource,
};
