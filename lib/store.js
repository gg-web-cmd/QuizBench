/* 저장소 — 설정·API 키·실행 기록을 파일로 다룬다.
 *
 *   %APPDATA%\QuizBench\
 *     settings.json          AI 목록(키 포함)·문제 지시문·채점 설정
 *     runs\<번호>.json        한 번 돌린 결과
 *     shots\<번호>.png        그때 찍어 보낸 화면
 *
 * ★ API 키를 다루므로 규칙이 하나 있다.
 *   키의 원문은 **이 프로세스 안에서만** 산다. 브라우저로 나가는 것은 언제나
 *   가려진 값(`sk-ant-…3f9a`)뿐이다. `safeProvider()` 를 거치지 않은 설정은
 *   절대 화면으로 내보내지 않는다. 기록·CSV 에도 키를 적지 않는다.
 *   `redact()` 는 그 마지막 그물이다 — SDK 오류 문구에 키가 섞여 나오는 일이 있다.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'QuizBench'
);
const SETTINGS = path.join(APP_DIR, 'settings.json');
const RUNS_DIR = path.join(APP_DIR, 'runs');
const SHOTS_DIR = path.join(APP_DIR, 'shots');

/* ── 기본값 ────────────────────────────────────────────────────────── */

/**
 * 화면에 처음 뜨는 AI 네 줄. 키는 비어 있고, 사용자가 채워 넣는다.
 * `kind` 가 말하는 통로는 lib/providers.js 에 있다.
 */
function defaultProviders() {
  return [
    { id: 'claude', kind: 'anthropic', label: 'Claude',  model: 'claude-opus-5',      apiKey: '', enabled: false, think: true,  effort: 'high' },
    { id: 'gpt',    kind: 'openai',    label: 'ChatGPT', model: 'gpt-5.1',            apiKey: '', enabled: false, think: false, effort: '' },
    { id: 'gemini', kind: 'google',    label: 'Gemini',  model: 'gemini-3.5-flash',   apiKey: '', enabled: false, think: false, effort: '' },
    /* Solar 는 그림을 못 읽어서, 그림→글자 통로를 앞에 붙여 쓴다(lib/providers.js 참고) */
    { id: 'solar',  kind: 'upstage',   label: 'Upstage Solar', model: 'solar-pro4',   apiKey: '', enabled: false, think: false, effort: '', ocrModel: 'document-parse' },
    /* xAI 의 Grok. OpenAI 와 같은 모양이라 호환 갈래로 되지만, 주소를 외울 필요가 없게
     * 미리 채워 둔다. (Groq 라는 다른 회사와 이름이 헷갈리니 이름표를 또렷이 쓴다) */
    { id: 'grok',   kind: 'compatible', label: 'Grok (xAI)', model: 'grok-4.6',       apiKey: '', enabled: false, think: false, effort: '', baseUrl: 'https://api.x.ai/v1' },
    /* OpenRouter — 한 키로 여러 회사 모델을 부르는 중개소. OpenAI 와 같은 모양이라
     * 호환 갈래로 되지만, 주소를 외울 필요가 없게 미리 채워 둔다.
     * 모델 이름이 "회사/모델" 꼴인 것만 다르다([모델 목록] 으로 고를 수 있다). */
    { id: 'openrouter', kind: 'compatible', label: 'OpenRouter', model: 'qwen/qwen3.8-max', apiKey: '', enabled: false, think: false, effort: '', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'etc',    kind: 'compatible', label: '기타(OpenAI 호환)', model: '', apiKey: '', enabled: false, think: false, effort: '', baseUrl: '' },
  ];
}

/* 문제를 읽히는 지시문. 모든 AI 에게 **똑같이** 간다 — 그래야 비교가 공평하다.
 *
 * 두 가지를 준비해 둔다.
 *   WHY   답과 함께 "왜 그렇게 봤는지" 를 한두 문장 받는다(기본)
 *   PLAIN 답만 받는다 — 빠르고 싸다
 * 화면의 "해설도 받기" 단추가 이 둘을 갈아 끼운다. */

const PROMPT_WHY = [
  '이 그림은 시험 문제지 화면입니다. 보이는 문제를 모두 풀어 주세요.',
  '',
  '규칙',
  '- 문제 번호는 화면에 적힌 번호를 그대로 씁니다.',
  '- 객관식이면 번호만(예: 3), 주관식이면 답만 짧게 씁니다.',
  '- "why" 에는 왜 그 답인지를 한두 문장으로 적습니다. 근거가 된 조건이나 셈을 밝혀 주세요.',
  '- 못 읽었거나 풀 수 없으면 답을 빈 칸("")으로 두고, "why" 에 그 까닭을 적습니다. 지어내지 마세요.',
  '',
  '아래 형식의 JSON 만 출력하세요. 다른 말은 쓰지 마세요.',
  '{"answers":[{"no":"1","answer":"3","why":"삼각형 세 각의 합이 180도라서 나머지 각은 60도입니다."},'
    + '{"no":"2","answer":"15","why":"3과 5의 최소공배수입니다."}]}',
].join('\n');

const PROMPT_PLAIN = [
  '이 그림은 시험 문제지 화면입니다. 보이는 문제를 모두 풀어 주세요.',
  '',
  '규칙',
  '- 문제 번호는 화면에 적힌 번호를 그대로 씁니다.',
  '- 객관식이면 번호만(예: 3), 주관식이면 답만 짧게 씁니다.',
  '- 풀이 과정은 적지 않습니다.',
  '- 못 읽었거나 풀 수 없으면 답을 빈 칸("")으로 둡니다. 지어내지 마세요.',
  '',
  '아래 형식의 JSON 만 출력하세요. 다른 말은 쓰지 마세요.',
  '{"answers":[{"no":"1","answer":"3"},{"no":"2","answer":"15"}]}',
].join('\n');

const DEFAULT_PROMPT = PROMPT_WHY;

/** 지금 지시문이 해설을 받고 있는가 (사용자가 고쳐 썼어도 알아본다) */
function asksWhy(prompt) { return /"why"|해설|왜 그 답|풀이 과정을 적/.test(String(prompt || '')); }

/** 지시문이 준비된 두 가지 중 하나 그대로인가 — 고쳐 쓴 것을 덮어쓰지 않으려고 본다 */
function isBuiltinPrompt(prompt) {
  const p = String(prompt || '').trim();
  return p === PROMPT_WHY.trim() || p === PROMPT_PLAIN.trim();
}

/**
 * 여러 장을 보낼 때 지시문 뒤에 덧붙이는 쪽지.
 * 장끼리 겹쳐 찍히므로 같은 문제가 두 번 보일 수 있다 — 그걸 미리 알려 준다.
 * (이 쪽지도 모든 AI 에게 똑같이 간다)
 */
function multiPageNote(count) {
  return '\n\n※ 화면이 길어서 ' + count + '장으로 나눠 찍었습니다.'
    + ' 장끼리 겹치는 부분이 있으니, 같은 번호의 문제는 한 번만 답하세요.'
    + ' 여러 장에 걸쳐 잘린 문제는 이어 붙여서 읽으세요.';
}

function defaults() {
  return {
    providers: defaultProviders(),
    prompt: DEFAULT_PROMPT,
    repeat: 1,           // 같은 화면을 몇 번 물어볼지(들쭉날쭉한 정도를 본다)
    timeoutSec: 180,
    scroll: true,        // 창을 굴려 내리며 끝까지 찍을지
    maxPages: 10,        // 굴리며 찍을 최대 장수
    wide: 'fit',         // 폭이 넘칠 때: fit(배율 줄이기) · side(옆으로도 찍기) · off
    lastHwnd: '',
    lastRegion: null,
  };
}

/* ── 읽기·쓰기 ─────────────────────────────────────────────────────── */

function ensureDirs() {
  for (const d of [APP_DIR, RUNS_DIR, SHOTS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

let cache = null;

/**
 * 다음 load() 가 디스크에서 다시 읽게 한다 — 프로그램을 껐다 켠 것과 같은 상태.
 * 새로 생긴 기본 줄을 넣어 주는 일은 그때 일어나므로, 점검이 그 순간을 만들 때 쓴다.
 */
function reload() { cache = null; return load(); }

function load() {
  if (cache) return cache;
  ensureDirs();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (_) { saved = {}; }

  const base = defaults();
  const out = { ...base, ...saved };

  /* 저장된 목록이 있으면 **그것이 기준**이다.
   * 기본 줄을 늘 다시 채워 넣으면 사용자가 지운 줄이 다음에 켤 때 되살아난다.
   * 그래서 지운 것은 지워진 채로 둔다. 줄마다 빠진 칸만 기본값으로 메운다. */
  const saw = Array.isArray(saved.providers) ? saved.providers : null;
  let list = (saw && saw.length ? saw : base.providers).map(fillProvider);

  /* 다만 **판이 올라가며 새로 생긴 기본 줄**은 한 번은 넣어 줘야 한다.
   * (Upstage 를 뒤늦게 더했는데 쓰던 사람 화면에 안 나오면 있으나 마나다)
   * "이 이름표를 이미 보여 준 적 있다" 를 적어 두고, 처음 보는 것만 넣는다.
   * 그걸 사용자가 지우면 이미 적혀 있으니 다시는 안 올라온다. */
  const seen = new Set(Array.isArray(saved.seenDefaults) ? saved.seenDefaults : []);
  if (saw && saw.length) {
    for (const d of base.providers) {
      if (seen.has(d.id)) continue;
      if (!list.some((p) => p.id === d.id)) list = [...list, fillProvider(d)];
    }
  }
  out.seenDefaults = [...new Set([...seen, ...base.providers.map((d) => d.id)])];
  out.providers = list;

  cache = out;
  return out;
}

/**
 * 우리가 예전에 기본값으로 내보냈다가 **못 쓰게 된** 모델 이름들.
 *
 * 모델 이름은 회사가 자꾸 바꾸고 옛 것은 문을 닫는다. 우리가 잘못 넣어 둔 이름이
 * 저장돼 있으면 업데이트를 해도 계속 404 가 난다 — 사용자는 우리가 고친 줄도 모른다.
 * 그래서 **우리가 내보냈던 그 값 그대로일 때만** 조용히 갈아 끼운다.
 * (사용자가 손으로 고른 이름은 절대 건드리지 않는다)
 */
const RETIRED_MODELS = {
  'gemini-3-pro': 'gemini-3.5-flash',      // 그런 이름이 없다(2026-08 확인)
};

/** AI 한 줄에 빠진 칸을 채운다 */
function fillProvider(p) {
  return {
    id: String(p.id || ''),
    kind: String(p.kind || 'compatible'),
    label: String(p.label || '이름 없음'),
    model: RETIRED_MODELS[String(p.model || '')] || String(p.model || ''),
    apiKey: String(p.apiKey || ''),
    baseUrl: String(p.baseUrl || ''),
    enabled: !!p.enabled,
    think: p.think !== false,
    effort: String(p.effort || 'high'),
    /* 그림을 못 읽는 갈래에서 "그림 → 글자" 를 무엇으로 할지 */
    ocrModel: String(p.ocrModel || 'document-parse'),
  };
}

/** 겹치지 않는 새 이름표를 짓는다 (openai → openai2, openai3 …) */
function newProviderId(kind, existing) {
  const taken = new Set(existing.map((p) => p.id));
  const stem = String(kind || 'ai').replace(/[^a-z0-9]/gi, '') || 'ai';
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 500; n++) {
    const id = stem + n;
    if (!taken.has(id)) return id;
  }
  return stem + '-' + Date.now();
}

function save(next) {
  ensureDirs();
  cache = { ...load(), ...next };
  const tmp = SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS);   // 쓰다 만 파일이 남지 않게
  return cache;
}

/* ── 키 가리기 ─────────────────────────────────────────────────────── */

/** `sk-ant-api03-xxxx…3f9a` → `sk-ant…3f9a`. 빈 값이면 빈 값. */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 10) return '·'.repeat(s.length);
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/** 화면으로 내보내도 되는 모습. 키 원문은 빼고 "있다/없다" 와 가린 값만 남긴다. */
function safeProvider(p) {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: !!String(apiKey || '').trim(), keyHint: maskKey(apiKey) };
}

function safeSettings(s) {
  const st = s || load();
  return { ...st, providers: st.providers.map(safeProvider) };
}

/**
 * 아무 글에서나 지금 저장된 키가 보이면 지운다.
 * SDK 오류 문구·URL 에 키가 섞여 나오는 일이 실제로 있어서, 화면·기록으로
 * 나가는 모든 글을 이걸로 한 번 씻는다.
 */
function redact(text) {
  let s = typeof text === 'string' ? text : JSON.stringify(text == null ? '' : text);
  const st = cache || load();
  for (const p of st.providers) {
    const k = String(p.apiKey || '').trim();
    if (k.length >= 8 && s.includes(k)) s = s.split(k).join('[키 가림]');
  }
  /* 저장돼 있지 않은 키라도 흔한 생김새면 가린다 */
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[키 가림]');
  return s;
}

/* ── 실행 기록 ─────────────────────────────────────────────────────── */

function nextRunId() {
  ensureDirs();
  let max = 0;
  try {
    for (const f of fs.readdirSync(RUNS_DIR)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (_) {}
  return max + 1;
}

function saveRun(run) {
  ensureDirs();
  const file = path.join(RUNS_DIR, run.id + '.json');
  fs.writeFileSync(file, JSON.stringify(run, null, 2), 'utf8');
  return file;
}

function loadRun(id) {
  try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, String(id) + '.json'), 'utf8')); }
  catch (_) { return null; }
}

/** 최근 것부터. 목록에는 무거운 답 본문을 빼고 요약만 담는다. */
function listRuns(limit) {
  ensureDirs();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch (_) {}
  files.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  for (const f of files.slice(0, limit || 50)) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
      out.push({
        id: r.id, at: r.at, title: r.title || '',
        windowTitle: r.windowTitle || '',
        providers: (r.results || []).map((x) => x.label),
        questions: (r.questions || []).length,
        graded: !!(r.grade && r.grade.perProvider),
      });
    } catch (_) {}
  }
  return out;
}

function shotPath(id) { ensureDirs(); return path.join(SHOTS_DIR, String(id) + '.png'); }

/**
 * 기록 하나를 지운다. 그때 찍어 둔 그림들도 함께 없앤다 —
 * 기록만 지우고 그림을 남기면 폴더가 조용히 불어난다.
 */
function deleteRun(id) {
  const key = String(id);
  if (!/^\d+$/.test(key)) return { ok: false, message: '잘못된 번호입니다' };

  const file = path.join(RUNS_DIR, key + '.json');
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (!rec) return { ok: false, message: '그 기록이 없습니다' };

  const keys = (rec.shotKeys && rec.shotKeys.length) ? rec.shotKeys : [key];
  for (const k of keys) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(k))) continue;   // 폴더를 거슬러 오르지 못하게
    try { fs.rmSync(shotPath(k), { force: true }); } catch (_) {}
  }
  try { fs.rmSync(file, { force: true }); } catch (_) { return { ok: false, message: '지우지 못했습니다' }; }
  return { ok: true };
}

/** 기록을 몽땅 지운다. 지운 개수를 돌려준다. */
function clearRuns() {
  ensureDirs();
  let n = 0;
  let files = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch (_) {}
  for (const f of files) {
    if (deleteRun(f.replace(/\.json$/, '')).ok) n++;
  }
  /* 기록에 딸리지 않고 남은 그림도 치운다.
   * 단 `preview*` 는 건드리지 않는다 — 지금 화면에서 보고 있는 것이라,
   * 지난 기록을 지웠다고 눈앞의 것까지 사라지면 놀란다. */
  try {
    for (const f of fs.readdirSync(SHOTS_DIR)) {
      if (/^preview(-\d+)?\.png$/.test(f)) continue;
      try { fs.rmSync(path.join(SHOTS_DIR, f), { force: true }); } catch (_) {}
    }
  } catch (_) {}
  return n;
}

module.exports = {
  APP_DIR, SETTINGS, RUNS_DIR, SHOTS_DIR,
  DEFAULT_PROMPT, PROMPT_WHY, PROMPT_PLAIN, asksWhy, isBuiltinPrompt, multiPageNote,
  defaults, defaultProviders, load, save, reload, ensureDirs,
  fillProvider, newProviderId, RETIRED_MODELS,
  maskKey, safeProvider, safeSettings, redact,
  nextRunId, saveRun, loadRun, listRuns, shotPath, deleteRun, clearRuns,
};
