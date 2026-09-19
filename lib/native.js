/* 도우미(worker.exe) 다리.
 *
 * 화면을 캡처하고 이미지를 찾고 마우스를 누르는 일은 Node 혼자서는 못 한다.
 * 그래서 작은 C# 프로그램(native/worker.cs)을 윈도우에 이미 들어 있는 컴파일러로 한 번 만들어 두고,
 * 그 프로그램과 한 줄짜리 JSON 을 주고받으며 부린다.
 *
 *   - 만든 exe 는 %LOCALAPPDATA%\QuizBench\bin\worker-<해시>.exe 에 남겨 둔다.
 *     소스가 바뀌면 해시가 달라져서 저절로 다시 만든다.
 *   - 도우미가 죽으면 다음 부탁 때 조용히 다시 띄운다.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const runtime = require('./runtime');

const BIN_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'QuizBench', 'bin'
);

const state = {
  exe: '',              // 만들어 둔 도우미 exe 경로
  proc: null,           // 지금 도는 프로세스
  ready: null,          // 기동을 기다리는 Promise
  info: null,           // info 응답(화면 목록 등)
  seq: 1,               // 요청 번호
  pending: new Map(),   // 번호 → {resolve, reject, timer}
  buf: '',              // stdout 조각 모음
  env: { stop: false, cursor: [0, 0], locked: false, idleMs: 0 },
  onEnv: null,          // env 가 바뀔 때 부를 함수
  onLog: null,          // 진단 문구를 흘릴 함수
  lastError: '',
  compiled: false,
};

/* ── 컴파일 ────────────────────────────────────────────────────────── */

/** 윈도우에 늘 들어 있는 C# 컴파일러를 찾는다 */
function findCsc() {
  const win = process.env.SystemRoot || 'C:\\Windows';
  const fixed = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;

  /* 버전 폴더 이름이 다를 수도 있으니 훑어본다 */
  for (const dir of ['Framework64', 'Framework']) {
    const base = path.join(win, 'Microsoft.NET', dir);
    let subs = [];
    try { subs = fs.readdirSync(base).filter((d) => /^v4\./.test(d)).sort().reverse(); } catch (_) { continue; }
    for (const s of subs) {
      const p = path.join(base, s, 'csc.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

/** 도우미 exe 를 준비한다(이미 있으면 그냥 쓴다). 경로를 돌려준다. */
function build() {
  if (state.exe && fs.existsSync(state.exe)) return state.exe;

  const src = runtime.nativeSource();
  if (!src) throw new Error('도우미 프로그램의 소스(native/worker.cs)를 찾을 수 없습니다.');

  const hash = crypto.createHash('sha1').update(src, 'utf8').digest('hex').slice(0, 8);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const exe = path.join(BIN_DIR, 'worker-' + hash + '.exe');

  if (fs.existsSync(exe)) { state.exe = exe; return exe; }

  const csc = findCsc();
  if (!csc) {
    throw new Error(
      '윈도우에 들어 있는 C# 컴파일러(csc.exe)를 찾지 못했습니다.\n'
      + '제어판 → 프로그램 및 기능 → Windows 기능에서 ".NET Framework 4.x" 를 켜 주세요.'
    );
  }

  /* 한글 주석·문구가 깨지지 않게 BOM 을 붙여 저장한다 */
  const csFile = path.join(BIN_DIR, 'worker-' + hash + '.cs');
  fs.writeFileSync(csFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(src, 'utf8')]));

  const args = [
    '-nologo', '-unsafe', '-optimize+', '-target:winexe',
    '-out:' + exe,
    '-r:System.dll', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.Core.dll',
    csFile,
  ];
  try {
    execFileSync(csc, args, { windowsHide: true, timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = ((e && e.stdout) || '') + ((e && e.stderr) || '');
    throw new Error('도우미 프로그램을 만들지 못했습니다.\n' + String(out).trim().slice(0, 1200));
  }
  if (!fs.existsSync(exe)) throw new Error('도우미 프로그램이 만들어지지 않았습니다(원인을 알 수 없음).');

  /* 옛 버전은 지워 둔다 */
  try {
    for (const f of fs.readdirSync(BIN_DIR)) {
      if (/^worker-/.test(f) && f.indexOf(hash) === -1) {
        try { fs.rmSync(path.join(BIN_DIR, f), { force: true }); } catch (_) {}
      }
    }
  } catch (_) {}

  state.compiled = true;
  state.exe = exe;
  return exe;
}

/* ── 프로세스 다루기 ───────────────────────────────────────────────── */

function noteEnv(env) {
  if (!env || typeof env !== 'object') return;
  const before = JSON.stringify([state.env.stop, state.env.locked]);
  state.env = {
    stop: !!env.stop,
    cursor: Array.isArray(env.cursor) ? env.cursor : state.env.cursor,
    locked: !!env.locked,
    idleMs: typeof env.idleMs === 'number' ? env.idleMs : 0,
  };
  if (state.onEnv && JSON.stringify([state.env.stop, state.env.locked]) !== before) {
    try { state.onEnv(state.env); } catch (_) {}
  }
}

function failAll(reason) {
  for (const [, p] of state.pending) {
    clearTimeout(p.timer);
    try { p.reject(new Error(reason)); } catch (_) {}
  }
  state.pending.clear();
}

function handleLine(line) {
  const t = line.trim();
  if (!t || t[0] !== '{') return;
  let msg;
  try { msg = JSON.parse(t); } catch (_) { return; }
  noteEnv(msg.env);

  if (msg.id === 0) {                       // 기동 신호
    state.info = msg.data || null;
    if (state.ready && state.ready.resolveNow) state.ready.resolveNow(state.info);
    return;
  }
  const p = state.pending.get(msg.id);
  if (!p) return;
  state.pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.data || {});
  else p.reject(new Error(String(msg.error || '도우미가 이유 없이 거절했습니다')));
}

function start() {
  if (state.proc && !state.proc.killed) return state.ready;

  const exe = build();
  const proc = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  state.proc = proc;
  state.buf = '';

  let resolveNow = null;
  let rejectNow = null;
  const ready = new Promise((res, rej) => { resolveNow = res; rejectNow = rej; });
  ready.resolveNow = resolveNow;
  state.ready = ready;

  const bootTimer = setTimeout(() => {
    if (rejectNow) rejectNow(new Error('도우미 프로그램이 응답하지 않습니다(10초).'));
  }, 10000);
  ready.then(() => clearTimeout(bootTimer), () => clearTimeout(bootTimer));

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    state.buf += chunk;
    let at;
    while ((at = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, at);
      state.buf = state.buf.slice(at + 1);
      handleLine(line);
    }
    if (state.buf.length > 4 * 1024 * 1024) state.buf = '';   // 이상하면 버린다
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    const s = String(chunk).trim();
    if (s && state.onLog) { try { state.onLog(s.slice(0, 400)); } catch (_) {} }
  });

  proc.on('error', (e) => {
    state.lastError = e.message;
    if (rejectNow) rejectNow(new Error('도우미 프로그램을 실행할 수 없습니다: ' + e.message));
    failAll('도우미 프로그램을 실행할 수 없습니다: ' + e.message);
    state.proc = null;
  });

  proc.on('close', (code) => {
    state.proc = null;
    state.ready = null;
    const why = '도우미 프로그램이 멈췄습니다(코드 ' + code + '). 다시 띄웁니다.';
    state.lastError = why;
    if (rejectNow) rejectNow(new Error(why));
    failAll(why);
  });

  return ready;
}

/**
 * 도우미에게 일을 시킨다.
 *   await call('find', {items:[...]}, 20000)
 * 도우미가 죽어 있으면 한 번 다시 띄워 본다.
 */
async function call(cmd, args, timeoutMs, _retried) {
  if (!state.proc) {
    try { await start(); }
    catch (e) { throw e; }
  } else if (state.ready) {
    try { await state.ready; } catch (e) { /* 아래에서 다시 시도 */ }
  }
  if (!state.proc) {
    if (_retried) throw new Error(state.lastError || '도우미 프로그램이 없습니다');
    return call(cmd, args, timeoutMs, true);
  }

  const id = state.seq++;
  const line = JSON.stringify({ id: id, cmd: cmd, args: args || {} }) + '\n';
  const ms = timeoutMs || 30000;

  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('도우미가 "' + cmd + '" 를 ' + Math.round(ms / 1000) + '초 안에 끝내지 못했습니다'));
    }, ms);
    state.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    try { state.proc.stdin.write(line); }
    catch (e) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(new Error('도우미에게 말을 걸 수 없습니다: ' + e.message));
    }
  });

  try { return await p; }
  catch (e) {
    /* 프로세스가 죽어서 실패한 경우라면 한 번만 다시 해 본다 */
    if (!_retried && !state.proc && !/안에 끝내지 못했습니다/.test(e.message)) {
      return call(cmd, args, timeoutMs, true);
    }
    throw e;
  }
}

/* ── 편한 껍데기들 ─────────────────────────────────────────────────── */

async function ensure() {
  await start();
  if (!state.info) state.info = await call('info', {}, 10000);
  return state.info;
}

function info() { return state.info; }
function env() { return state.env; }
function isBusy() { return state.pending.size > 0; }
function madeNewExe() { return state.compiled; }
function exePath() { return state.exe; }

function onEnv(fn) { state.onEnv = fn; }
function onLog(fn) { state.onLog = fn; }

/** stop 깃발 내리기 — 실행을 시작할 때마다 부른다 */
async function clearStop() {
  try { await call('clearstop', {}, 5000); state.env.stop = false; } catch (_) {}
}

async function stop() {
  if (!state.proc) return;
  try { await call('bye', {}, 1500); } catch (_) {}
  const p = state.proc;
  state.proc = null;
  state.ready = null;
  setTimeout(() => { try { p.kill(); } catch (_) {} }, 400);
}

module.exports = {
  BIN_DIR, build, findCsc, ensure, call, info, env, isBusy, onEnv, onLog,
  clearStop, stop, madeNewExe, exePath,
};
