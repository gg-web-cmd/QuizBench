/* 문제풀이도구 — 로컬 서버
 *
 *   node server.js [포트]
 *
 * 화면에 띄워 둔 문제(한글·엑셀·크롬·엣지 어떤 창이든)를 찍어서
 * 여러 AI 에게 한꺼번에 풀리고, 정답지와 대조해 AI 별 정답률을 낸다.
 *
 * 브라우저는 화면만 담당한다. 창 찍기·AI 부르기·채점은 전부 이 프로세스가 한다.
 * 127.0.0.1 만 듣는다.
 *
 * ★ API 키를 다루는 도구다. 지키는 것:
 *   · 키는 %APPDATA%\QuizBench\settings.json 에만 있고, 그 AI 회사 말고
 *     어디로도 가지 않는다.
 *   · 브라우저로 나가는 모든 응답은 store.safeSettings()/redact() 를 거쳐
 *     가려진 값만 싣는다. 자체 점검이 이걸 실제로 확인한다.
 *   · 기록·CSV 에도 키를 적지 않는다.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ARGS = process.argv.slice(2);
const START_PORT = parseInt(ARGS.find((a) => /^\d+$/.test(a)), 10) || 8205;
const NO_OPEN = ARGS.includes('--no-open') || process.env.NO_OPEN === '1';

/* 자체 점검은 **다른 무엇을 불러오기 전에** 갈라져야 한다.
 * lib/store.js 는 불러오는 순간 %APPDATA% 를 읽어 저장 폴더를 정하는데,
 * 점검은 그 자리를 임시 폴더로 바꿔치기해서 사용자 자료를 건드리지 않기 때문이다. */
if (ARGS.includes('--selftest')) {
  require('./lib/selftest').run()
    .then((c) => { console.log('SELFTEST OK — ' + c.join(' · ')); process.exit(0); })
    .catch((e) => { console.error('SELFTEST FAIL — ' + ((e && e.stack) || e)); process.exit(1); });
  return;
}

const runtime = require('./lib/runtime');
const store = require('./lib/store');
const providers = require('./lib/providers');
const grade = require('./lib/grade');
const run = require('./lib/run');
const native = require('./lib/native');
const dialogs = require('./lib/dialogs');
const peek = require('./lib/peek');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  /* .mjs 를 빠뜨리면 브라우저가 "모듈이 아니다" 며 pdf.js 를 아예 안 받는다 */
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  /* pdf.js 가 곁들여 쓰는 것들 */
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
};

/* ── 상태 ──────────────────────────────────────────────────────────── */

const state = {
  windows: [],
  shot: null,        // { id, pages[], w, h, blank, note, windowTitle } — 그림으로 풀 때
  paper: '',         // 올린 문서에서 뽑아 낸 글자 — 글자로 풀 때
  paperName: '',
  current: null,     // 마지막으로 돌린 결과(채점 전/후)
  busy: false,
  abort: null,       // 지금 도는 일을 멈출 손잡이
  lastDir: '',
};

/* ── SSE — 진행 상황 흘려보내기 ─────────────────────────────────────── */

const clients = new Set();

function push(event) {
  const line = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch (_) {} }
}

/* ── HTTP 도우미 ───────────────────────────────────────────────────── */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* 브라우저가 보내 오는 것 중 가장 큰 것은 **올린 파일**이다.
 * PDF 30쪽을 1800px 로 구우면 base64 로 수십 MB 가 된다(한 쪽에 0.5~2MB).
 * 예전 한도는 8MB 였는데, 그걸 넘으면 여기서 req.destroy() 로 연결을 끊었다.
 * 그러면 브라우저 쪽에는 우리 말이 한 마디도 안 닿고 fetch 가 그냥 깨져서
 * 영문 "Failed to fetch" 만 뜬다 — 사용자에겐 그저 "업로드가 안 됨"이다.
 * 그래서 (1) 한도를 파일 크기에 맞추고, (2) 넘더라도 연결을 끊지 않고
 * 끝까지 받아 넘긴 뒤 **우리말로 된 까닭**을 돌려준다. */
const BODY_LIMIT = 96 * 1024 * 1024;

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        /* 더 담지는 않되 흐름은 끝까지 받는다 — 끊으면 답을 못 전한다 */
        if (!tooBig) { tooBig = true; chunks.length = 0; }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ __tooBig: size });
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

/** 화면으로 내보낼 지금 모습. 키는 절대 안 실린다. */
function snapshot() {
  const st = store.load();
  return {
    settings: store.safeSettings(st),
    asksWhy: store.asksWhy(st.prompt),
    promptEdited: !store.isBuiltinPrompt(st.prompt),
    kinds: Object.fromEntries(Object.entries(providers.KINDS).map(([k, v]) => [k, {
      label: v.label, needsUrl: v.needsUrl, canThink: v.canThink, seesImage: v.seesImage !== false,
    }])),
    windows: state.windows,
    shot: state.shot ? {
      id: state.shot.id, w: state.shot.w, h: state.shot.h,
      blank: state.shot.blank, note: state.shot.note,
      windowTitle: state.shot.windowTitle,
      scrolled: !!state.shot.scrolled,
      pages: (state.shot.pages || []).map((p) => ({ key: p.key, w: p.w, h: p.h })),
    } : null,
    paper: state.paper
      ? { name: state.paperName, chars: state.paper.length, sample: state.paper.slice(0, 400) }
      : null,
    result: state.current,
    busy: state.busy,
    appDir: store.APP_DIR,
    home: os.homedir(),
  };
}

/* ── API ───────────────────────────────────────────────────────────── */

const api = {
  async 'GET /api/env'() { return snapshot(); },
  async 'GET /api/state'() { return snapshot(); },

  /* 창 목록 새로 고치기 */
  async 'POST /api/windows'() {
    try {
      await native.ensure();
      state.windows = await run.listWindows(native);
      return { ok: true, ...snapshot() };
    } catch (e) {
      return { ok: false, message: store.redact((e && e.message) || String(e)), ...snapshot() };
    }
  },

  /* 설정 저장. 키가 빈 글자로 오면 "그대로 두기" 로 본다(가린 값을 되돌려 보내도 안전하게). */
  async 'POST /api/settings'(body) {
    const st = store.load();
    const next = {};

    if (Array.isArray(body.providers)) {
      const old = new Map(st.providers.map((p) => [p.id, p]));
      next.providers = body.providers.map((p) => {
        const prev = old.get(p.id) || {};
        const keyGiven = typeof p.apiKey === 'string' && p.apiKey.trim() !== '';
        return {
          ...prev, ...p,
          /* 화면은 가린 값만 알고 있다 — 새로 입력했을 때만 갈아 끼운다 */
          apiKey: keyGiven ? p.apiKey.trim() : (prev.apiKey || ''),
        };
      });
    }
    for (const k of ['prompt', 'repeat', 'timeoutSec', 'scroll', 'maxPages', 'wide', 'lastHwnd', 'lastRegion']) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    store.save(next);
    return { ok: true, ...snapshot() };
  },

  /* 한 AI 의 키를 지운다 */
  async 'POST /api/forget-key'(body) {
    const st = store.load();
    const ps = st.providers.map((p) => (p.id === body.id ? { ...p, apiKey: '' } : p));
    store.save({ providers: ps });
    return { ok: true, ...snapshot() };
  },

  /* AI 줄 더하기 — 종류를 골라서 넣는다.
   * 같은 회사의 다른 모델끼리 견주는 것도 이걸로 된다(예: opus 대 sonnet). */
  async 'POST /api/add-provider'(body) {
    const st = store.load();
    if (st.providers.length >= 12) return { ok: false, message: 'AI 는 12줄까지 넣을 수 있습니다' };

    const kind = providers.KINDS[body.kind] ? body.kind : 'compatible';
    const id = store.newProviderId(kind, st.providers);
    const label = String(body.label || '').trim().slice(0, 24)
      || (providers.KINDS[kind].label + ' ' + (st.providers.filter((p) => p.kind === kind).length + 1));

    const added = store.fillProvider({
      id, kind, label,
      model: String(body.model || '').trim(),
      baseUrl: String(body.baseUrl || '').trim(),
      enabled: false,
    });
    store.save({ providers: [...st.providers, added] });
    return { ok: true, addedId: id, ...snapshot() };
  },

  /* AI 줄 지우기 — 마지막 한 줄은 남긴다 */
  async 'POST /api/remove-provider'(body) {
    const st = store.load();
    if (st.providers.length <= 1) return { ok: false, message: '마지막 한 줄은 지울 수 없습니다' };
    const ps = st.providers.filter((p) => p.id !== body.id);
    if (ps.length === st.providers.length) return { ok: false, message: '그런 AI 가 없습니다' };
    store.save({ providers: ps });
    return { ok: true, ...snapshot() };
  },

  /* 처음 상태로 되돌리기 (키는 살려 둔다) */
  async 'POST /api/reset-providers'() {
    const st = store.load();
    const keys = new Map(st.providers.map((p) => [p.id, p.apiKey]));
    const ps = store.defaultProviders().map((p) => store.fillProvider({ ...p, apiKey: keys.get(p.id) || '' }));
    store.save({ providers: ps });
    return { ok: true, ...snapshot() };
  },

  /* 해설(왜 그 답인지)을 받을지 말지 — 지시문을 통째로 갈아 끼운다.
   * 사용자가 손으로 고쳐 쓴 지시문은 force 없이는 덮어쓰지 않는다. */
  async 'POST /api/explain'(body) {
    const st = store.load();
    const want = !!body.on;
    if (store.asksWhy(st.prompt) === want) return { ok: true, ...snapshot() };
    if (!store.isBuiltinPrompt(st.prompt) && !body.force) {
      return { ok: false, needsConfirm: true, message: '지시문을 고쳐 쓰셨습니다. 준비된 문구로 바꿀까요?' };
    }
    store.save({ prompt: want ? store.PROMPT_WHY : store.PROMPT_PLAIN });
    return { ok: true, ...snapshot() };
  },

  /* 그 AI 가 지금 쓸 수 있는 모델 이름 물어보기 */
  async 'POST /api/models'(body) {
    const st = store.load();
    const p = st.providers.find((x) => x.id === body.id);
    if (!p) return { ok: false, message: '모르는 AI 입니다' };
    try {
      const list = await providers.listModels(p);
      return { ok: true, models: list };
    } catch (e) {
      return { ok: false, message: store.redact((e && e.message) || String(e)) };
    }
  },

  /* 고른 창을 찍어 미리 보여 주기.
   * "굴려 내리며 끝까지" 가 켜져 있으면 여러 장을 찍는다. */
  async 'POST /api/shot'(body) {
    if (state.busy) return { ok: false, message: '지금 다른 일을 하고 있습니다' };
    state.busy = true;
    try {
      await native.ensure();
      const st = store.load();
      const hwnd = body.hwnd || '';
      const region = body.region && body.region.w > 0 ? body.region : null;

      /* 지난번에 찍어 둔 장들을 치운다 */
      for (const f of state.shot ? state.shot.pages || [] : []) {
        try { fs.rmSync(f.path, { force: true }); } catch (_) {}
      }

      /* 영역을 골라 놓았으면 굴리지 않는다 — 고른 자리에 다른 내용이 흘러 들어와
       * "보이는 그대로 간다" 가 깨진다. 영역은 한 장 그대로 쓰는 것이 맞다. */
      const wantScroll = st.scroll !== false && !!hwnd && !region && !body.once;

      let pages, scrolled = false, note = '';
      if (wantScroll) {
        const r = await run.captureScrolling(native, {
          hwnd, region, maxPages: st.maxPages || 10,
          wide: st.wide || 'fit',
          fileFor: (n) => store.shotPath('preview' + (n === 0 ? '' : '-' + (typeof n === 'number' ? n + 1 : n))),
          onEvent: push,
        });
        pages = r.pages; scrolled = r.scrolled; note = r.note;
      } else {
        const got = await run.capture(native, { hwnd, region, file: store.shotPath('preview') });
        pages = [got]; note = got.note || '';
      }

      if (!pages.length) return { ok: false, message: '그림을 얻지 못했습니다' };

      const w = state.windows.find((x) => x.hwnd === hwnd);
      state.shot = {
        id: 'preview',
        pages: pages.map((p, i) => ({ path: p.path, key: 'preview' + (i ? '-' + (i + 1) : ''), w: p.w, h: p.h })),
        path: pages[0].path, w: pages[0].w, h: pages[0].h,
        blank: pages.every((p) => p.blank),
        woke: pages.some((p) => p.woke),
        scrolled, note,
        windowTitle: w ? w.title : (hwnd ? '' : '화면 전체'),
        hwnd, region,
      };
      store.save({ lastHwnd: hwnd, lastRegion: region });
      return { ok: true, ...snapshot(), stamp: Date.now() };
    } catch (e) {
      return { ok: false, message: store.redact((e && e.message) || String(e)) };
    } finally {
      state.busy = false;
    }
  },

  /* ── 파일 올려서 풀기 ────────────────────────────────────────────
   * 창을 찍는 대신 파일을 그대로 준다. 두 갈래로 들어온다.
   *   pages : 브라우저가 만든 PNG 들 (사진 파일, PDF 를 쪽마다 구운 것)
   *   doc   : 워드·한글 같은 문서 — 여기서 글자를 뽑아 넣는다
   */
  async 'POST /api/upload-pages'(body) {
    const list = Array.isArray(body.pages) ? body.pages : [];
    if (!list.length) return { ok: false, message: '올린 그림이 없습니다' };
    if (list.length > 30) return { ok: false, message: '한 번에 30장까지 됩니다' };

    /* 지난번 것을 치운다 */
    for (const f of state.shot ? state.shot.pages || [] : []) {
      try { fs.rmSync(f.path, { force: true }); } catch (_) {}
    }

    const pages = [];
    for (let i = 0; i < list.length; i++) {
      const b64 = String(list[i].png || '').replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      /* PNG 인지 확인한다 — 아무 바이트나 받아 두면 나중에 AI 쪽에서 알 수 없는 오류가 난다 */
      if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
        return { ok: false, message: (i + 1) + '번째 그림이 PNG 가 아닙니다' };
      }
      const key = 'preview' + (i ? '-' + (i + 1) : '');
      const p = store.shotPath(key);
      fs.writeFileSync(p, buf);
      pages.push({ path: p, key, w: Number(list[i].w) || 0, h: Number(list[i].h) || 0 });
    }

    state.paper = '';
    state.shot = {
      id: 'preview', pages, path: pages[0].path, w: pages[0].w, h: pages[0].h,
      blank: false, scrolled: false, note: '',
      windowTitle: String(body.name || '올린 파일').slice(0, 80),
      hwnd: '', region: null, fromFile: true,
    };
    return { ok: true, ...snapshot(), stamp: Date.now() };
  },

  /* 워드·한글 등 문서 — 글자를 뽑아 그대로 푼다(그림이 아니라 글자로 간다) */
  async 'POST /api/upload-doc'(body) {
    const name = String(body.name || '문서');
    const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) || [, ''])[1].toLowerCase();
    if (!ext || !peek.canPeek(ext)) {
      return { ok: false, message: '"' + ext + '" 는 글자를 뽑을 수 없는 형식입니다' };
    }

    const buf = Buffer.from(String(body.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) return { ok: false, message: '파일이 비어 있습니다' };
    if (buf.length > 60 * 1024 * 1024) return { ok: false, message: '파일이 너무 큽니다 (60MB 까지)' };

    /* 뽑는 동안만 임시로 둔다 — 사용자의 원본은 건드리지 않는다 */
    const tmp = path.join(store.APP_DIR, 'upload-tmp.' + ext);
    let text = '';
    try {
      fs.writeFileSync(tmp, buf);
      text = peek.peek(tmp, ext) || '';
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }

    text = text.trim();
    if (text.length < 20) {
      return { ok: false, message: '글자를 거의 못 뽑았습니다. 사진이나 PDF 로 올려 보세요.' };
    }

    /* 그림 쪽은 비운다 — 이제 글자로 간다 */
    for (const f of state.shot ? state.shot.pages || [] : []) {
      try { fs.rmSync(f.path, { force: true }); } catch (_) {}
    }
    state.shot = null;
    state.paper = text;
    state.paperName = name;
    return { ok: true, chars: text.length, sample: text.slice(0, 400), ...snapshot() };
  },

  /* 올린 것 치우기 — 다시 창을 찍는 길로 돌아간다 */
  async 'POST /api/clear-upload'() {
    for (const f of state.shot ? state.shot.pages || [] : []) {
      try { fs.rmSync(f.path, { force: true }); } catch (_) {}
    }
    state.shot = null;
    state.paper = '';
    state.paperName = '';
    return { ok: true, ...snapshot() };
  },

  /* 실제로 돌리기 — AI 들에게 물어보기 */
  async 'POST /api/run'(body) {
    if (state.busy) return { ok: false, message: '이미 돌고 있습니다' };
    const st = store.load();

    const picked = st.providers.filter((p) => p.enabled && String(p.apiKey || '').trim());
    if (!picked.length) return { ok: false, message: 'API 키를 넣고 켜 둔 AI 가 없습니다' };

    const byText = !!state.paper;
    if (!byText && !state.shot) return { ok: false, message: '먼저 창을 찍거나 파일을 올려 주세요' };
    if (!byText && state.shot.blank) return { ok: false, message: '찍은 그림이 비어 있습니다 — 창이 최소화되어 있지 않은지 보세요' };

    state.busy = true;
    state.abort = new AbortController();
    const id = store.nextRunId();

    try {
      let pngs = [];
      let kept = [];
      let prompt = st.prompt || store.DEFAULT_PROMPT;

      if (!byText) {
        /* 미리 본 그림(들)을 이 실행의 것으로 남긴다 — 모두에게 같은 그림이 간다 */
        const shotPages = (state.shot.pages && state.shot.pages.length ? state.shot.pages : [{ path: state.shot.path }]);
        shotPages.forEach((p, i) => {
          const key = id + (i ? '-' + (i + 1) : '');
          const dest = store.shotPath(key);
          fs.copyFileSync(p.path, dest);
          kept.push({ key, path: dest });
        });
        pngs = kept.map((k) => fs.readFileSync(k.path));
        /* 여러 장이면 그 사실을 지시문 뒤에 덧붙인다(모두에게 똑같이) */
        if (pngs.length > 1) prompt += store.multiPageNote(pngs.length);
      }

      push({
        type: 'run-start', id, count: picked.length, repeat: st.repeat || 1,
        pages: pngs.length, byText,
      });

      const results = await run.askAll(picked, {
        pngs,
        paper: byText ? state.paper : '',
        prompt,
        timeoutMs: Math.max(20, Number(st.timeoutSec) || 180) * 1000,
        repeat: st.repeat || 1,
        signal: state.abort.signal,
        onEvent: push,
      });

      const rec = {
        id,
        at: new Date().toISOString(),
        windowTitle: byText ? (state.paperName || '올린 문서') : state.shot.windowTitle,
        shot: kept.length ? path.basename(kept[0].path) : '',
        shotKeys: kept.map((k) => k.key),
        pages: pngs.length,
        byText,
        paperChars: byText ? state.paper.length : 0,
        prompt,
        repeat: st.repeat || 1,
        results,
        questions: run.questionNumbers(results),
        grade: null,
        answerKey: '',
      };
      store.saveRun(rec);
      state.current = rec;
      push({ type: 'run-done', id, questions: rec.questions.length });
      return { ok: true, ...snapshot() };
    } catch (e) {
      const msg = store.redact((e && e.message) || String(e));
      push({ type: 'run-fail', message: msg });
      return { ok: false, message: msg };
    } finally {
      state.busy = false;
      state.abort = null;
    }
  },

  async 'POST /api/stop'() {
    if (state.abort) { try { state.abort.abort(); } catch (_) {} }
    return { ok: true };
  },

  /* 정답지를 넣어 채점 */
  async 'POST /api/grade'(body) {
    if (!state.current) return { ok: false, message: '채점할 결과가 없습니다' };
    const key = grade.parseKey(body.answerKey || '');
    if (!Object.keys(key).length) {
      return { ok: false, message: '정답지를 읽지 못했습니다. "1 3" 처럼 줄마다 번호와 답을 적어 주세요.' };
    }
    const g = grade.grade(state.current.results, key, { loose: !!body.loose });
    state.current.grade = g;
    state.current.answerKey = String(body.answerKey || '');
    state.current.loose = !!body.loose;
    store.saveRun(state.current);
    return { ok: true, ...snapshot() };
  },

  /* 표를 CSV 로 저장 */
  async 'POST /api/export'() {
    const cur = state.current;
    if (!cur || !cur.grade) return { ok: false, message: '먼저 채점해 주세요' };
    const suggest = 'AI채점_' + new Date().toISOString().slice(0, 10) + '.csv';
    const file = await dialogs.saveFileAs('채점표를 저장할 곳', suggest, 'CSV 파일|*.csv|모든 파일|*.*',
      state.lastDir || path.join(os.homedir(), 'Documents'));
    if (!file) return { cancelled: true };
    const csv = grade.toCsv(cur.grade, cur.results);
    fs.writeFileSync(file, csv, 'utf8');
    state.lastDir = path.dirname(file);
    return { ok: true, file };
  },

  /* 지난 기록 */
  async 'GET /api/runs'() { return { ok: true, runs: store.listRuns(50) }; },

  /* 기록 하나 지우기 — 찍어 둔 그림도 함께 없앤다 */
  async 'POST /api/delete-run'(body) {
    const r = store.deleteRun(body.id);
    if (!r.ok) return { ok: false, message: r.message };
    /* 지금 보고 있던 것이면 화면에서도 내린다 */
    if (state.current && String(state.current.id) === String(body.id)) state.current = null;
    return { ok: true, runs: store.listRuns(50), ...snapshot() };
  },

  /* 기록 몽땅 지우기 */
  async 'POST /api/clear-runs'() {
    const n = store.clearRuns();
    state.current = null;
    return { ok: true, removed: n, runs: store.listRuns(50), ...snapshot() };
  },

  async 'POST /api/load-run'(body) {
    const r = store.loadRun(body.id);
    if (!r) return { ok: false, message: '그 기록이 없습니다' };
    state.current = r;

    /* 그때 찍어 둔 장들을 되살린다(옛 기록은 한 장뿐이다) */
    const keys = (r.shotKeys && r.shotKeys.length) ? r.shotKeys : [String(r.id)];
    const pages = keys
      .map((k) => ({ key: k, path: store.shotPath(k) }))
      .filter((p) => fs.existsSync(p.path));

    if (pages.length) {
      state.shot = {
        id: r.id, pages, path: pages[0].path, w: 0, h: 0,
        blank: false, scrolled: pages.length > 1, note: '',
        windowTitle: r.windowTitle || '', hwnd: '', region: null,
      };
    }
    return { ok: true, ...snapshot() };
  },

  async 'POST /api/reveal'(body) {
    const target = body.path || store.APP_DIR;
    await dialogs.reveal(target);
    return { ok: true };
  },

  async 'POST /api/reset-prompt'() {
    store.save({ prompt: store.DEFAULT_PROMPT });
    return { ok: true, ...snapshot() };
  },

  async 'POST /api/quit'() { setTimeout(shutdown, 150); return { ok: true }; },
};

/* ── 서버 ──────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (_) { res.writeHead(400).end('Bad request'); return; }
  if (rel === '/' || rel === '') rel = '/index.html';

  /* 진행 상황 흘려보내기 */
  if (rel === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': 연결됨\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  /* 찍어 둔 그림 내주기 — %APPDATA% 안의 정해진 파일만 */
  const shotMatch = rel.match(/^\/shot\/([A-Za-z0-9_-]{1,40})\.png$/);
  if (shotMatch) {
    const file = store.shotPath(shotMatch[1]);
    let body = null;
    try { body = fs.readFileSync(file); } catch (_) {}
    if (!body) { res.writeHead(404).end('no shot'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  const key = `${req.method} ${rel}`;
  if (api[key]) {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      if (body.__tooBig) {
        return sendJson(res, 200, {
          ok: false,
          message: '보낸 내용이 너무 큽니다 ('
            + (body.__tooBig / 1048576).toFixed(1) + 'MB · '
            + Math.round(BODY_LIMIT / 1048576) + 'MB 까지).\n'
            + 'PDF 라면 쪽수를 줄이거나, 필요한 쪽만 따로 저장해 올려 주세요.',
        });
      }
      return sendJson(res, 200, await api[key](body));
    } catch (e) {
      return sendJson(res, 500, { error: store.redact((e && e.message) || String(e)) });
    }
  }
  if (rel.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  const body = runtime.webAsset(path.posix.normalize(rel));
  if (!body) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 — ' + rel); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
});

function listen(port, tries = 12) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    console.error('서버를 시작하지 못했습니다: ' + e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log('');
    console.log('  문제풀이도구 — AI 문제 풀이 실력 재기');
    console.log('  ' + url);
    console.log('');
    console.log('  API 키는 이 PC 의 ' + store.APP_DIR + ' 에만 저장됩니다.');
    console.log('  창을 닫으면 종료됩니다.');
    if (!NO_OPEN) execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  });
}
listen(START_PORT);

function shutdown() {
  try { native.stop(); } catch (_) {}
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, shutdown); } catch (_) {}
}
process.on('uncaughtException', (e) => { console.error('예상 못한 오류: ' + store.redact((e && e.stack) || String(e))); });
