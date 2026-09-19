/* 문제풀이도구 → 단일 exe 빌드
 *
 *   node build.js
 *
 * Node 24 의 SEA(Single Executable Application) 기능을 쓴다.
 * node.exe 사본에 우리 코드와 화면 파일을 통째로 박아 넣는 방식이라,
 * 결과물 하나만 복사하면 Node 설치 없이 어디서든 돈다.
 *
 * 순서가 중요하다: 아이콘·버전(rcedit) → 코드 주입(postject).
 * 거꾸로 하면 자원이 커져서 rcedit 이 끝나지 않는다.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const BUILD = path.join(HERE, 'build');
const DIST = path.join(HERE, 'dist');
const NAME = 'QuizBench';
const KOREAN_NAME = '문제풀이도구.exe';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (n, msg) => console.log(`[${String(n).padStart(3)}/6] ${msg}`);
const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);

/* ── 1. 코드 한 덩어리로 묶기 ──────────────────────────────────────── */

async function bundle() {
  step(1, '코드 묶는 중 (esbuild)');
  const esbuild = require('esbuild');
  const outfile = path.join(BUILD, 'bundle.js');
  const r = await esbuild.build({
    entryPoints: [path.join(HERE, 'sea-entry.js')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: false,           // 오류 메시지를 읽을 수 있게 남겨 둔다
    legalComments: 'none',
    logLevel: 'warning',
  });
  if (r.errors.length) throw new Error('묶기 실패');
  console.log(`      → build/bundle.js (${mb(outfile)} MB)`);
  return outfile;
}

/* ── 2. exe 안에 넣을 자원 목록 ────────────────────────────────────── */

/**
 * 화면 파일(WEB_FILES)과 도우미 소스(NATIVE_FILES)를 함께 넣는다.
 * 목록은 lib/runtime.js 한 곳에만 있다 — 넣는 쪽과 꺼내 쓰는 쪽이 어긋나지 않게.
 */
function seaConfig(bundlePath) {
  step(2, 'exe 에 넣을 파일 정리');
  const runtime = require('./lib/runtime');
  const { WEB_FILES, NATIVE_FILES, VENDOR_MUST_HAVE } = runtime;
  if (!WEB_FILES || !WEB_FILES.length) throw new Error('lib/runtime.js 의 WEB_FILES 가 비어 있습니다');
  if (!NATIVE_FILES || !NATIVE_FILES.length) throw new Error('lib/runtime.js 의 NATIVE_FILES 가 비어 있습니다 (/native/worker.cs 가 필요합니다)');

  /* pdf.js 알맹이는 파일이 200개 가까워서 손으로 안 적고 폴더를 훑는다 */
  const vendor = runtime.vendorFiles();
  if (vendor.length < 50) {
    throw new Error('vendor\\ 안의 pdf.js 알맹이를 찾지 못했습니다 (' + vendor.length + '개). PDF 를 못 그리게 됩니다.');
  }

  const assets = {};
  for (const key of [...WEB_FILES, ...NATIVE_FILES, ...vendor]) {
    assets[key] = path.join(HERE, key.slice(1)).replace(/\\/g, '/');
  }

  for (const [k, v] of Object.entries(assets)) {
    if (!fs.existsSync(v)) throw new Error(`자원을 찾을 수 없습니다: ${k} → ${v}`);
    if (!k.startsWith('/vendor/')) console.log(`      ${k}  (${(fs.statSync(v).size / 1024).toFixed(1)} KB)`);
  }
  console.log(`      /vendor/**  ${vendor.length}개 (pdf.js)`);

  /* 꼭 있어야 할 것이 빠지면 여기서 잡는다 — 빌드 뒤에 알면 늦다 */
  for (const must of VENDOR_MUST_HAVE) {
    if (!assets[must]) throw new Error('pdf.js 에 꼭 필요한 파일이 없습니다: ' + must);
  }

  const cfg = {
    main: bundlePath.replace(/\\/g, '/'),
    output: path.join(BUILD, 'sea-prep.blob').replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,       // 켜면 빨라지지만 Node 버전이 바뀌면 깨진다
    assets,
  };
  const file = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  return { file, blob: cfg.output };
}

function makeBlob(configFile) {
  step(3, '실행 블롭 생성');
  execFileSync(process.execPath, ['--experimental-sea-config', configFile], { stdio: 'inherit', cwd: HERE });
}

/**
 * 원본 node.exe 에 붙어 있는 디지털 서명을 떼어 낸다.
 * 코드를 주입하는 순간 서명은 무효가 되는데, 깨진 서명이 남아 있으면
 * 윈도우가 "손상된 파일" 로 볼 수 있어서 아예 없애는 편이 낫다.
 */
function stripSignature(exe) {
  try {
    execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' });
    return 'signtool';
  } catch (_) { /* 아래로 */ }

  const buf = fs.readFileSync(exe);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') return '건너뜀';

  const optOff = peOff + 24;
  const plus = buf.readUInt16LE(optOff) === 0x20b;          // PE32+ 인가
  const dirsOff = optOff + (plus ? 112 : 96);
  const dirCount = buf.readUInt32LE(optOff + (plus ? 108 : 92));
  if (dirCount < 5) return '서명 없음';

  const secOff = dirsOff + 4 * 8;                            // 5번째 = 인증서 테이블
  const certAt = buf.readUInt32LE(secOff);                   // 여기는 RVA 가 아니라 파일 오프셋
  const certLen = buf.readUInt32LE(secOff + 4);
  if (!certAt || !certLen) return '서명 없음';

  buf.writeUInt32LE(0, secOff);
  buf.writeUInt32LE(0, secOff + 4);
  const end = certAt + certLen >= buf.length ? certAt : buf.length;
  fs.writeFileSync(exe, buf.subarray(0, end));
  return `${(certLen / 1024).toFixed(0)}KB 제거`;
}

function prepareExe() {
  step(3.5, 'node.exe 사본 준비');
  fs.mkdirSync(DIST, { recursive: true });
  const exe = path.join(DIST, NAME + '.exe');
  fs.rmSync(exe, { force: true });
  fs.copyFileSync(process.execPath, exe);
  console.log('      기존 서명: ' + stripSignature(exe));
  return exe;
}

/** 아이콘과 파일 정보. 반드시 블롭 주입 *전* 이어야 한다. */
async function brand(exe) {
  step(4, '아이콘과 파일 정보 넣기');
  const icon = require('./make-icon').main();
  const { rcedit } = await import('rcedit');            // rcedit 5 는 ESM 전용
  await rcedit(exe, {
    icon,
    'version-string': {
      ProductName: '문제풀이도구',
      FileDescription: '화면의 문제를 여러 AI 에게 동시에 풀리고 정답률을 재는 로컬 웹 도구',
      OriginalFilename: NAME + '.exe',
      InternalName: NAME,
    },
    'file-version': '1.0.0.0',
    'product-version': '1.0.0.0',
  });
}

function inject(exe, blob) {
  step(5, '실행 코드 주입 (postject)');
  const postject = path.join(HERE, 'node_modules', 'postject', 'dist', 'cli.js');
  execFileSync(process.execPath, [
    postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE,
  ], { stdio: 'inherit', cwd: HERE });
  return exe;
}

/* ── 6. 확인 ───────────────────────────────────────────────────────── */

/**
 * 만들어진 exe 를 바로 돌려 본다. 도우미(worker.cs)를 실제로 컴파일하므로
 * 처음 한 번은 몇십 초가 걸릴 수 있다.
 *
 * 점검을 통과하지 못한 exe 는 반드시 지운다 — build_installer.ps1 이
 * "exe 가 이미 있으면 빌드를 건너뛴다" 라서, 남겨 두면 깨진 파일이 설치본에 담긴다.
 */
function smokeTest(exe) {
  step(6, '동작 확인 (도우미 컴파일 + 자체 점검)');
  const scrap = () => { try { fs.rmSync(exe, { force: true }); } catch (_) { /* 무시 */ } };

  let out;
  try {
    out = execFileSync(exe, ['--selftest'], {
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
      env: { ...process.env, NO_OPEN: '1' },
    });
  } catch (e) {
    scrap();
    throw e;
  }
  if (!/SELFTEST OK/.test(out)) { scrap(); throw new Error('자체 점검 실패:\n' + out); }
  console.log('      ' + out.trim().split(/\r?\n/).pop());
}

/* ── 진행 ──────────────────────────────────────────────────────────── */

async function main() {
  if (os.platform() !== 'win32') throw new Error('이 빌드 스크립트는 윈도우 전용입니다.');
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });

  const bundlePath = await bundle();
  const { file, blob } = seaConfig(bundlePath);
  makeBlob(file);
  const exe = prepareExe();
  await brand(exe);
  inject(exe, blob);
  smokeTest(exe);

  const korean = path.join(DIST, KOREAN_NAME);
  fs.copyFileSync(exe, korean);

  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log(`  완료!  dist\\${KOREAN_NAME}   (${mb(korean)} MB)`);
  console.log(`         dist\\${NAME}.exe      (같은 파일, 영문 이름)`);
  console.log(line);
  console.log('  · 이 exe 하나만 복사하면 Node 없이 어디서든 실행됩니다.');
  console.log('  · 두 번 클릭하면 브라우저가 열리고, 검은 창을 닫으면 종료됩니다.');
  console.log('  · 처음 실행할 때 창 캡처 도우미를 한 번 컴파일합니다(몇 초).');
  console.log('  · API 키는 이 PC 의 %APPDATA%\\QuizBench 에만 저장됩니다.');
}

main().catch((e) => {
  console.error('\n빌드 실패:', e.message);
  process.exit(1);
});
