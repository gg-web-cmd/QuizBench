/* AI 어댑터 — 그림 몇 장과 지시문을 주면 답을 글로 돌려준다.
 *
 * 어떤 AI 든 바깥에서 보는 모습은 하나다:
 *
 *   const r = await ask(provider, { pngs, prompt, timeoutMs, signal });
 *   // pngs = [Buffer, …]  창이 길어 스크롤하며 여러 장 찍었을 수 있다
 *   // r = { text, usage:{in,out}, ms, model, note }
 *
 * ── 공평함에 대하여 ────────────────────────────────────────────────
 * 이 도구는 AI 들을 **견주는** 도구다. 그래서 지시문은 모든 AI 에게 글자 하나까지
 * 똑같이 간다. 어느 한쪽에만 구조화 출력(JSON 강제)이나 예시를 더 얹으면
 * 그건 모델의 실력이 아니라 우리가 만든 차이가 되어 버린다.
 * 모델마다 다른 것은 "그 모델이 원래 가진 것"(예: 생각하기)뿐이고,
 * 그것도 화면에서 켜고 끌 수 있게 두어 사용자가 조건을 안다.
 *
 * ── 되돌아오는 답에 대하여 ─────────────────────────────────────────
 * 답은 JSON 으로 달라고 했지만 모델은 종종 ```json 울타리나 앞말을 붙인다.
 * 그건 lib/grade.js 의 느슨한 파서가 감당한다. 여기서는 글자만 그대로 넘긴다.
 */
'use strict';

const store = require('./store');

/* SDK 는 처음 쓸 때 불러온다 — 안 쓰는 AI 때문에 기동이 느려지지 않게. */
let _anthropic = null, _openai = null, _genai = null;
function sdkAnthropic() { if (!_anthropic) { const m = require('@anthropic-ai/sdk'); _anthropic = m.default || m; } return _anthropic; }
function sdkOpenAI() { if (!_openai) { const m = require('openai'); _openai = m.default || m; } return _openai; }
function sdkGenAI() { if (!_genai) _genai = require('@google/genai'); return _genai; }

/* ── 도우미 ────────────────────────────────────────────────────────── */

class ProviderError extends Error {
  constructor(msg, kind) { super(store.redact(msg)); this.kind = kind || 'error'; }
}

function needKey(p) {
  const k = String(p.apiKey || '').trim();
  if (!k) throw new ProviderError(p.label + ' 의 API 키가 비어 있습니다.', 'nokey');
  return k;
}
function needModel(p) {
  const m = String(p.model || '').trim();
  if (!m) throw new ProviderError(p.label + ' 의 모델 이름이 비어 있습니다.', 'nomodel');
  return m;
}

/** 두 글자 이상 남기고 끝의 슬래시를 떼어 낸다 */
function trimSlash(u) { return String(u || '').trim().replace(/\/+$/, ''); }

/* 잠깐 넘어졌다 일어나는 곳을 위해 한 번 더 걸어 본다.
 * 다른 갈래는 SDK 의 maxRetries:1 이 이 몫을 대신한다 — 생 HTTP 로 가는 이 길만
 * 스스로 해야 한다. 총 횟수이므로 2 가 곧 "한 번 더" 이고, 그래야 조건이 같아진다.
 * 주의: 다시 걸어도 timeoutMs 예산은 **함께 쓴다**(마감은 하나뿐). */
const COMPAT_ATTEMPTS = 2;
const RETRY_WAIT_MS = 1000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/* 답의 길이 상한.
 * 안 보내면 곳에 따라 모델 최대치(수만 토큰)를 통째로 잡아 둔다. 중개소(OpenRouter
 * 같은 곳)는 그 최대치만큼 **미리 요금을 잡아 두고** 모자라면 402 로 거절하므로,
 * 쓰지도 않을 자리 때문에 아예 못 푸는 일이 생긴다.
 * 이 도구가 받는 답은 JSON 한 덩이 — 해설을 켜도 20문항에 2,000 토큰 남짓이라
 * 4,000 이면 두 배 여유다. 그래도 모자라면 아래에서 finish_reason 을 보고 알려 준다. */
const COMPAT_MAX_TOKENS = 4000;

/** 기다리되, 그 사이에 그만두라고 하면 곧바로 그만둔다 */
function sleep(ms, signal) {
  return new Promise((res) => {
    if (signal && signal.aborted) return res();
    const id = setTimeout(done, ms);
    function done() { clearTimeout(id); if (signal) signal.removeEventListener('abort', done); res(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * 그림 목록을 늘 배열로 만들어 준다.
 * 한 장이든 여러 장이든 어댑터가 같은 길로 가게 하려는 것 —
 * 갈래마다 "한 장일 때" 를 따로 두면 거기서 어긋난다.
 */
function asPngs(opts) {
  const list = Array.isArray(opts.pngs) ? opts.pngs : (opts.png ? [opts.png] : []);
  const out = list.filter((b) => b && b.length);
  if (!out.length) throw new ProviderError('보낼 그림이 없습니다.', 'noimage');
  return out;
}

/**
 * 그림 대신 **글자**로 온 문제지(워드·한글 문서를 올린 경우).
 * 있으면 그림은 보내지 않고 이 글을 지시문 앞에 붙인다.
 */
function paperOf(opts) {
  const s = String(opts.paper || '').trim();
  return s ? s : '';
}

function withPaper(paper, prompt) {
  return '아래는 시험 문제지에서 뽑아 낸 글입니다.\n\n'
    + '----- 문제지 -----\n' + paper + '\n----- 끝 -----\n\n' + prompt;
}

/** 여러 장일 때 몇 번째 장인지 알려 주는 쪽지. 한 장이면 붙이지 않는다. */
function pageLabel(i, total) { return total > 1 ? (i + 1) + '번째 장 (전체 ' + total + '장)' : ''; }

/* ── 1. Claude (Anthropic) ─────────────────────────────────────────── */

/**
 * 주의: 서버 쪽 대체 모델(fallbacks)은 **일부러 켜지 않는다.**
 * 대체가 돌면 claude-opus-5 를 재려던 자리에 다른 모델의 답이 조용히 들어와
 * 측정이 어긋난다. 재는 도구에서는 거절을 그대로 "거절" 로 보여 주는 편이 옳다.
 */
async function askAnthropic(p, opts0) {
  const { prompt, timeoutMs, signal } = opts0;
  const pngs = asPngs(opts0);
  const Anthropic = sdkAnthropic();
  const opts = { apiKey: needKey(p), timeout: timeoutMs, maxRetries: 1 };
  if (p.baseUrl) opts.baseURL = trimSlash(p.baseUrl);   // 사내 게이트웨이·자체 점검용
  const client = new Anthropic(opts);

  const content = [];
  pngs.forEach((png, i) => {
    const lab = pageLabel(i, pngs.length);
    if (lab) content.push({ type: 'text', text: lab });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  });
  content.push({ type: 'text', text: prompt });

  const body = {
    model: needModel(p),
    max_tokens: 16000,
    messages: [{ role: 'user', content }],
  };

  if (p.think === false) {
    /* 생각을 끄면 effort 를 high 위로 올릴 수 없다(400). 넘치면 눌러 준다. */
    body.thinking = { type: 'disabled' };
    const e = String(p.effort || 'high');
    body.output_config = { effort: (e === 'xhigh' || e === 'max') ? 'high' : e };
  } else {
    body.thinking = { type: 'adaptive' };
    if (p.effort) body.output_config = { effort: String(p.effort) };
  }

  const r = await client.messages.create(body, { signal });

  if (r.stop_reason === 'refusal') {
    const why = (r.stop_details && r.stop_details.category) || '';
    throw new ProviderError('모델이 답하기를 거절했습니다' + (why ? ' (' + why + ')' : ''), 'refusal');
  }

  const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    usage: { in: (r.usage && r.usage.input_tokens) || 0, out: (r.usage && r.usage.output_tokens) || 0 },
    model: r.model || body.model,
    note: r.stop_reason === 'max_tokens' ? '길이 제한에 걸려 답이 잘렸습니다' : '',
  };
}

/* ── 2. ChatGPT (OpenAI) ───────────────────────────────────────────── */

async function askOpenAI(p, opts0) {
  const { prompt, timeoutMs, signal } = opts0;
  const pngs = asPngs(opts0);
  const OpenAI = sdkOpenAI();
  const opts = { apiKey: needKey(p), timeout: timeoutMs, maxRetries: 1 };
  if (p.baseUrl) opts.baseURL = trimSlash(p.baseUrl);
  const client = new OpenAI(opts);

  const content = [];
  pngs.forEach((png, i) => {
    const lab = pageLabel(i, pngs.length);
    if (lab) content.push({ type: 'input_text', text: lab });
    content.push({ type: 'input_image', image_url: 'data:image/png;base64,' + png.toString('base64') });
  });
  content.push({ type: 'input_text', text: prompt });

  const r = await client.responses.create({
    model: needModel(p),
    input: [{ role: 'user', content }],
  }, { signal });

  const u = r.usage || {};
  return {
    text: r.output_text || '',
    usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 },
    model: r.model || p.model,
    note: r.status && r.status !== 'completed' ? ('상태: ' + r.status) : '',
  };
}

/* ── 3. Gemini (Google) ────────────────────────────────────────────── */

async function askGoogle(p, opts0) {
  const { prompt, timeoutMs, signal } = opts0;
  const pngs = asPngs(opts0);
  const { GoogleGenAI } = sdkGenAI();
  /* 재시도를 명시하지 않으면 SDK 가 재시도 길로 아예 안 간다(생 fetch 한 방).
   * 그러면 일시적인 503/429 하나에 이 AI 만 통째로 실패한다 — 다른 AI 는
   * maxRetries:1 을 받으므로 그건 모델 실력이 아니라 우리가 만든 차이가 된다.
   * attempts 는 첫 호출을 포함한 총 횟수라, 2 가 다른 갈래의 maxRetries:1 과 같다.
   * 주의: 재시도는 timeoutMs 예산을 **나눠 쓴다**(abort 는 요청당 하나뿐). */
  const httpOptions = { timeout: timeoutMs, retryOptions: { attempts: 2 } };
  if (p.baseUrl) httpOptions.baseUrl = trimSlash(p.baseUrl);   // 자체 점검용
  const ai = new GoogleGenAI({ apiKey: needKey(p), httpOptions });

  const parts = [];
  pngs.forEach((png, i) => {
    const lab = pageLabel(i, pngs.length);
    if (lab) parts.push({ text: lab });
    parts.push({ inlineData: { mimeType: 'image/png', data: png.toString('base64') } });
  });
  parts.push({ text: prompt });

  const r = await ai.models.generateContent({
    model: needModel(p),
    contents: [{ role: 'user', parts }],
    config: { abortSignal: signal },
  });

  const u = r.usageMetadata || {};
  const fin = r.candidates && r.candidates[0] && r.candidates[0].finishReason;
  if (fin && fin !== 'STOP' && fin !== 'MAX_TOKENS') {
    throw new ProviderError('모델이 답을 멈췄습니다 (' + fin + ')', fin === 'SAFETY' ? 'refusal' : 'error');
  }
  return {
    text: r.text || '',
    usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 },
    model: p.model,
    note: fin === 'MAX_TOKENS' ? '길이 제한에 걸려 답이 잘렸습니다' : '',
  };
}

/* ── 4. 기타 — OpenAI 호환 주소 ────────────────────────────────────── */

/**
 * 국내 모델이나 사내 서버처럼 "OpenAI 와 같은 모양" 을 내주는 곳을 위한 길.
 * SDK 를 쓰지 않고 생 HTTP 로 보낸다 — 어느 SDK 의 규칙에도 매이지 않기 위해서다.
 */
async function askCompatible(p, opts0) {
  const { prompt, timeoutMs, signal } = opts0;
  const pngs = asPngs(opts0);
  const base = trimSlash(p.baseUrl);
  if (!base) throw new ProviderError('주소(baseUrl)가 비어 있습니다.', 'nourl');
  const url = /\/(v\d+|chat\/completions)$/.test(base)
    ? (base.endsWith('/chat/completions') ? base : base + '/chat/completions')
    : base + '/v1/chat/completions';

  /* 보낼 것은 한 번만 만든다 — 그림이 여러 장이면 이 글이 수 MB 라,
   * 다시 걸 때마다 새로 만들면 그만큼 또 든다. */
  const body = JSON.stringify({
    model: needModel(p),
    max_tokens: COMPAT_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: (() => {
        const c = [];
        pngs.forEach((png, i) => {
          const lab = pageLabel(i, pngs.length);
          if (lab) c.push({ type: 'text', text: lab });
          c.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } });
        });
        c.push({ type: 'text', text: prompt });
        return c;
      })(),
    }],
  });

  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), timeoutMs);
  const onAbort = () => timer.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let rs, raw;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        rs = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + needKey(p) },
          signal: timer.signal,
          body,
        });
      } catch (e) {
        if (timer.signal.aborted) throw new ProviderError('시간 안에 답하지 않았습니다.', 'timeout');
        if (attempt >= COMPAT_ATTEMPTS) throw new ProviderError('연결하지 못했습니다: ' + e.message, 'network');
        await sleep(RETRY_WAIT_MS, timer.signal);
        continue;
      }
      raw = await rs.text();
      if (rs.ok || attempt >= COMPAT_ATTEMPTS || !RETRYABLE_STATUS.has(rs.status)) break;
      await sleep(RETRY_WAIT_MS, timer.signal);
    }
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!rs.ok) {
    /* 키가 틀린 것은 "서버가 거절" 이 아니라 **키 문제** 라고 말해 줘야 사용자가 고칠 수 있다.
     * 직통 갈래(Claude·GPT·Gemini)와 Upstage 는 이미 그렇게 한다 — 여기만 빠져 있었다. */
    if (rs.status === 401 || rs.status === 403) {
      throw new ProviderError('API 키가 거절당했습니다 (' + rs.status + '). 키를 다시 확인하세요.', 'auth');
    }
    /* 402 는 "돈이 모자라다" 는 뜻이다. 중개소(OpenRouter 등)에서 잔액이 없거나,
     * 잡아 두려는 자리(max_tokens)가 잔액보다 클 때 온다 — 키나 모델 문제가 아니다. */
    if (rs.status === 402) {
      throw new ProviderError('잔액이 모자랍니다 (402). 그 곳에 돈을 채우거나 더 싼 모델로 바꾸세요. — ' + raw.slice(0, 200), 'credit');
    }
    throw new ProviderError('서버가 거절했습니다 (' + rs.status + '): ' + raw.slice(0, 300), 'http');
  }

  let j;
  try { j = JSON.parse(raw); } catch (_) { throw new ProviderError('답을 알아볼 수 없습니다: ' + raw.slice(0, 200), 'parse'); }

  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const u = j.usage || {};
  /* 상한에 걸려 잘린 답을 조용히 넘기면 "이 AI 가 몇 문제를 빠뜨렸다" 로 잘못 읽힌다.
   * 그건 모델의 실력이 아니라 우리가 건 상한이므로 반드시 밝힌다(Anthropic 갈래와 같다). */
  const fin = j.choices && j.choices[0] && j.choices[0].finish_reason;
  return {
    text: (msg && (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) || '',
    usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 },
    model: j.model || p.model,
    note: fin === 'length' ? '길이 제한에 걸려 답이 잘렸습니다' : '',
  };
}

/* ── 5. Upstage Solar — 그림을 못 읽으므로 글자로 바꿔 넣는다 ───────── */

const UPSTAGE_BASE = 'https://api.upstage.ai/v1';

/**
 * Solar 는 **그림을 받지 않는다.** 공식 API 문서가 그렇게 못 박고 있고,
 * 실제로 그림을 실어 보내도 읽지 못한다. 그래서 다른 AI 처럼 화면 사진을
 * 그냥 던지면 아무것도 못 푼다(사용자가 겪은 일이 이것이다).
 *
 * 대신 Upstage 에는 **그림에서 글자를 뽑는 통로**가 따로 있고 같은 키로 쓴다.
 * 그래서 두 걸음으로 나눈다.
 *
 *   1) 그림 → 글자   POST /v1/document-digitization   (model: ocr | document-parse)
 *   2) 글자 → 답     POST /v1/chat/completions        (model: solar-pro4 …)
 *
 * ★ 이 갈래만 **입력이 다르다.** 다른 AI 는 그림을 그대로 보지만 이쪽은 글자만 본다.
 *   그림으로만 알 수 있는 것(그래프 모양·도형·표 자리)은 이 AI 에게 불리하다.
 *   견주기에서 이 사실을 숨기면 안 되므로 화면·기록에 늘 "글자로 읽음" 이라고 적는다.
 */
async function askUpstage(p, opts0) {
  const { prompt, timeoutMs, signal } = opts0;
  const pngs = asPngs(opts0);
  const key = needKey(p);
  const base = trimSlash(p.baseUrl) || UPSTAGE_BASE;
  const ocrModel = String(p.ocrModel || 'document-parse');

  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), timeoutMs);
  const onAbort = () => timer.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    /* ── 1걸음: 그림에서 글자 뽑기 ── */
    const chunks = [];
    for (let i = 0; i < pngs.length; i++) {
      const form = new FormData();
      form.append('model', ocrModel);
      form.append('document', new Blob([pngs[i]], { type: 'image/png' }), 'page' + (i + 1) + '.png');

      let rs;
      try {
        rs = await fetch(base + '/document-digitization', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + key },
          body: form,
          signal: timer.signal,
        });
      } catch (e) {
        if (timer.signal.aborted) throw new ProviderError('시간 안에 답하지 않았습니다.', 'timeout');
        throw new ProviderError('글자 뽑는 곳에 닿지 못했습니다: ' + e.message, 'network');
      }

      const raw = await rs.text();
      if (!rs.ok) {
        if (rs.status === 401 || rs.status === 403) throw new ProviderError('API 키가 거절당했습니다 (' + rs.status + ').', 'auth');
        throw new ProviderError('그림에서 글자를 뽑지 못했습니다 (' + rs.status + '): ' + raw.slice(0, 200), 'ocr');
      }

      let j;
      try { j = JSON.parse(raw); } catch (_) { throw new ProviderError('글자 뽑기 응답을 알아볼 수 없습니다.', 'parse'); }

      const text = pickOcrText(j);
      if (!text) throw new ProviderError('그림에서 글자를 하나도 뽑지 못했습니다.', 'ocr');
      chunks.push(pngs.length > 1 ? ('[' + (i + 1) + '번째 장]\n' + text) : text);
    }

    const paper = chunks.join('\n\n');

    /* ── 2걸음: 뽑은 글자로 풀리기 ── */
    let rs2;
    try {
      rs2 = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        signal: timer.signal,
        body: JSON.stringify({
          model: needModel(p),
          messages: [{
            role: 'user',
            content: '아래는 시험 문제지에서 뽑아 낸 글입니다.\n\n'
              + '----- 문제지 -----\n' + paper + '\n----- 끝 -----\n\n' + prompt,
          }],
        }),
      });
    } catch (e) {
      if (timer.signal.aborted) throw new ProviderError('시간 안에 답하지 않았습니다.', 'timeout');
      throw new ProviderError('연결하지 못했습니다: ' + e.message, 'network');
    }

    const raw2 = await rs2.text();
    if (!rs2.ok) {
      if (rs2.status === 401 || rs2.status === 403) throw new ProviderError('API 키가 거절당했습니다 (' + rs2.status + ').', 'auth');
      if (rs2.status === 404) throw new ProviderError('그런 모델이 없습니다 (404). 모델 이름을 확인하세요.', 'model');
      throw new ProviderError('서버가 거절했습니다 (' + rs2.status + '): ' + raw2.slice(0, 200), 'http');
    }

    let j2;
    try { j2 = JSON.parse(raw2); } catch (_) { throw new ProviderError('답을 알아볼 수 없습니다.', 'parse'); }

    const msg = j2.choices && j2.choices[0] && j2.choices[0].message;
    const u = j2.usage || {};
    return {
      text: (msg && (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) || '',
      usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 },
      model: j2.model || p.model,
      viaText: true,
      note: '그림에서 글자를 뽑아(' + ocrModel + ') 풀었습니다 — 그림 자체는 못 봅니다',
    };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 글자 뽑기 응답에서 글을 건져 낸다.
 * 통로마다 담는 자리가 달라서(ocr 은 `text`, document-parse 는 `content.*`)
 * 있을 만한 자리를 차례로 본다. 못 찾으면 빈 글자를 돌려주고 부르는 쪽이 알린다.
 */
function pickOcrText(j) {
  if (!j || typeof j !== 'object') return '';
  if (typeof j.text === 'string' && j.text.trim()) return j.text.trim();
  const c = j.content;
  if (c && typeof c === 'object') {
    for (const k of ['markdown', 'text', 'html']) {
      if (typeof c[k] === 'string' && c[k].trim()) return c[k].trim();
    }
  }
  if (Array.isArray(j.pages)) {
    const joined = j.pages.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
    if (joined.trim()) return joined.trim();
  }
  if (Array.isArray(j.elements)) {
    const joined = j.elements.map((e) => {
      if (!e) return '';
      if (typeof e.text === 'string') return e.text;
      if (e.content && typeof e.content === 'object') return e.content.markdown || e.content.text || '';
      return '';
    }).filter(Boolean).join('\n');
    if (joined.trim()) return joined.trim();
  }
  return '';
}

/* ── 바깥으로 ──────────────────────────────────────────────────────── */

const KINDS = {
  anthropic: { label: 'Claude (Anthropic)', ask: askAnthropic, needsUrl: false, canThink: true, seesImage: true },
  openai: { label: 'ChatGPT (OpenAI)', ask: askOpenAI, needsUrl: false, canThink: false, seesImage: true },
  google: { label: 'Gemini (Google)', ask: askGoogle, needsUrl: false, canThink: false, seesImage: true },
  upstage: { label: 'Upstage Solar (글자로 읽음)', ask: askUpstage, needsUrl: false, canThink: false, seesImage: false },
  compatible: { label: 'OpenAI 호환 주소', ask: askCompatible, needsUrl: true, canThink: false, seesImage: true },
};

/**
 * 글자로만 온 문제지를 푼다 — 워드·한글 문서를 올렸을 때의 길.
 * 그림이 없으므로 어느 갈래든 같은 방법으로 물어볼 수 있다.
 */
async function askWithText(p, opts) {
  const body = { ...opts, pngs: [TEXT_ONLY_MARK] };   // 그림 자리는 비운다
  const prompt = withPaper(paperOf(opts), opts.prompt);

  if (p.kind === 'upstage') {
    /* Upstage 는 이미 글자로 푸는 길이 있다 — 글자 뽑기만 건너뛴다 */
    return askUpstageText(p, { ...opts, prompt });
  }
  if (p.kind === 'anthropic') {
    const Anthropic = sdkAnthropic();
    const o = { apiKey: needKey(p), timeout: opts.timeoutMs, maxRetries: 1 };
    if (p.baseUrl) o.baseURL = trimSlash(p.baseUrl);
    const client = new Anthropic(o);
    const b = { model: needModel(p), max_tokens: 16000, messages: [{ role: 'user', content: prompt }] };
    if (p.think === false) {
      b.thinking = { type: 'disabled' };
      const e = String(p.effort || 'high');
      b.output_config = { effort: (e === 'xhigh' || e === 'max') ? 'high' : e };
    } else {
      b.thinking = { type: 'adaptive' };
      if (p.effort) b.output_config = { effort: String(p.effort) };
    }
    const r = await client.messages.create(b, { signal: opts.signal });
    if (r.stop_reason === 'refusal') throw new ProviderError('모델이 답하기를 거절했습니다', 'refusal');
    return {
      text: (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(''),
      usage: { in: (r.usage && r.usage.input_tokens) || 0, out: (r.usage && r.usage.output_tokens) || 0 },
      model: r.model || p.model, viaText: true, note: '올린 문서의 글자로 풀었습니다',
    };
  }
  if (p.kind === 'google') {
    const { GoogleGenAI } = sdkGenAI();
    const httpOptions = { timeout: opts.timeoutMs, retryOptions: { attempts: 2 } };
    if (p.baseUrl) httpOptions.baseUrl = trimSlash(p.baseUrl);
    const ai = new GoogleGenAI({ apiKey: needKey(p), httpOptions });
    const r = await ai.models.generateContent({
      model: needModel(p),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { abortSignal: opts.signal },
    });
    const u = r.usageMetadata || {};
    return {
      text: r.text || '',
      usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 },
      model: p.model, viaText: true, note: '올린 문서의 글자로 풀었습니다',
    };
  }
  /* openai · compatible — 둘 다 OpenAI 모양이다 */
  const OpenAI = sdkOpenAI();
  const o = { apiKey: needKey(p), timeout: opts.timeoutMs, maxRetries: 1 };
  if (p.baseUrl) o.baseURL = trimSlash(p.baseUrl);
  const client = new OpenAI(o);
  const r = await client.responses.create({
    model: needModel(p),
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
  }, { signal: opts.signal });
  const u = r.usage || {};
  return {
    text: r.output_text || '',
    usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 },
    model: r.model || p.model, viaText: true, note: '올린 문서의 글자로 풀었습니다',
  };
}

/** Upstage 에서 글자 뽑기를 건너뛰고 곧장 푸는 길 */
async function askUpstageText(p, opts) {
  const base = trimSlash(p.baseUrl) || UPSTAGE_BASE;
  const rs = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + needKey(p) },
    signal: opts.signal,
    body: JSON.stringify({ model: needModel(p), messages: [{ role: 'user', content: opts.prompt }] }),
  });
  const raw = await rs.text();
  if (!rs.ok) {
    if (rs.status === 401 || rs.status === 403) throw new ProviderError('API 키가 거절당했습니다 (' + rs.status + ').', 'auth');
    throw new ProviderError('서버가 거절했습니다 (' + rs.status + '): ' + raw.slice(0, 200), 'http');
  }
  let j;
  try { j = JSON.parse(raw); } catch (_) { throw new ProviderError('답을 알아볼 수 없습니다.', 'parse'); }
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const u = j.usage || {};
  return {
    text: (msg && msg.content) || '',
    usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 },
    model: j.model || p.model, viaText: true, note: '올린 문서의 글자로 풀었습니다',
  };
}

const TEXT_ONLY_MARK = Buffer.from([0]);   // asPngs 를 통과시키기 위한 자리표(실제로 안 쓴다)

/** 응답 글에서 "그런 모델 없다" 는 말을 알아본다 — 200/400 으로 오는 곳도 있다 */
function isModelMissing(msg) {
  return /model_not_found|does not exist|not found for API version|unknown model|모델을 찾을 수 없/i.test(String(msg || ''));
}

/**
 * 그 키로 지금 쓸 수 있는 모델 이름 몇 개를 줄글로.
 * 실패해도 조용히 빈 글자를 준다 — 이건 덤으로 알려 주는 것이지, 여기서 또 넘어지면 안 된다.
 */
async function modelHint(p) {
  try {
    const list = await listModels(p);
    if (!list || !list.length) return '';
    /* 그림을 다루는 이름을 앞에 세워 준다 — 이 도구는 대개 그림을 보낸다 */
    const good = list.filter((m) => !/embed|tts|whisper|image-generation|imagen|moderation/i.test(m));
    const show = (good.length ? good : list).slice(0, 8);
    return show.join(', ') + (list.length > show.length ? ' …(' + list.length + '개)' : '');
  } catch (_) { return ''; }
}

/** AI 하나에게 문제지를 보여 주고 답을 받는다. 걸린 시간도 함께 잰다. */
async function ask(p, opts) {
  const kind = KINDS[p.kind];
  if (!kind) throw new ProviderError('모르는 종류입니다: ' + p.kind, 'kind');
  const t0 = Date.now();
  try {
    /* 글자로 온 문제지(워드·한글 문서)면 그림 길로 가지 않는다 */
    const r = paperOf(opts)
      ? await askWithText(p, opts)
      : await kind.ask(p, opts);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof ProviderError) {
      /* 생 HTTP 로 가는 갈래(호환·Upstage)는 404 를 스스로 던진다.
       * 그것도 모델 이름 문제이므로 여기서 똑같이 이름을 붙여 준다. */
      if (e.kind === 'model' || (e.kind === 'http' && isModelMissing(e.message))) {
        const names = await modelHint(p);
        const pe = new ProviderError(
          '"' + (p.model || '') + '" 라는 모델이 없습니다.'
          + (names ? ' 쓸 수 있는 이름: ' + names : ' [모델 목록] 을 눌러 이름을 골라 주세요.'),
          'model');
        pe.ms = Date.now() - t0;
        throw pe;
      }
      e.ms = Date.now() - t0;
      throw e;
    }
    /* SDK 가 던진 것들을 사람 말로 옮긴다 */
    const status = e && (e.status || e.statusCode);
    let msg = (e && e.message) || String(e);
    let kindOf = 'error';
    if (e && (e.name === 'AbortError' || /abort|timeout|timed out/i.test(msg))) { kindOf = 'timeout'; msg = '시간 안에 답하지 않았습니다.'; }
    else if (status === 401 || status === 403) { kindOf = 'auth'; msg = 'API 키가 거절당했습니다 (' + status + '). 키를 다시 확인하세요.'; }
    else if (status === 404 || isModelMissing(msg)) { kindOf = 'model'; msg = '"' + (p.model || '') + '" 라는 모델이 없습니다.'; }
    else if (status === 429) { kindOf = 'rate'; msg = '요청이 너무 잦습니다 (429). 잠시 뒤 다시 하세요.'; }
    else if (status >= 500) { kindOf = 'server'; msg = '상대 서버에 문제가 있습니다 (' + status + ').'; }

    /* 모델 이름이 틀렸으면 **쓸 수 있는 이름을 바로 붙여 준다.**
     * 모델 이름은 회사마다 자주 바뀌어서(예전 것이 문을 닫는다), "확인하세요" 만으로는
     * 사용자가 어디서 확인할지 모른다. 이미 물어볼 길이 있으니 그 자리에서 물어본다. */
    if (kindOf === 'model') {
      const names = await modelHint(p);
      msg += names ? (' 쓸 수 있는 이름: ' + names) : ' [모델 목록] 을 눌러 이름을 골라 주세요.';
    }

    const pe = new ProviderError(msg, kindOf);
    pe.ms = Date.now() - t0;
    throw pe;
  }
}

/** 그 AI 가 지금 쓸 수 있는 모델 이름을 물어본다(가능한 곳만). */
async function listModels(p) {
  const key = needKey(p);
  if (p.kind === 'anthropic') {
    const Anthropic = sdkAnthropic();
    const c = new Anthropic({ apiKey: key, timeout: 20000, maxRetries: 1 });
    const page = await c.models.list({ limit: 100 });
    return (page.data || []).map((m) => m.id);
  }
  if (p.kind === 'openai' || p.kind === 'compatible' || p.kind === 'upstage') {
    const OpenAI = sdkOpenAI();
    const opts = { apiKey: key, timeout: 20000, maxRetries: 1 };
    const url = p.baseUrl || (p.kind === 'upstage' ? UPSTAGE_BASE : '');
    if (url) opts.baseURL = trimSlash(url);
    const c = new OpenAI(opts);
    const page = await c.models.list();
    return (page.data || []).map((m) => m.id).sort();
  }
  if (p.kind === 'google') {
    const { GoogleGenAI } = sdkGenAI();
    const ai = new GoogleGenAI({ apiKey: key });
    const out = [];
    const page = await ai.models.list();
    for await (const m of page) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (id) out.push(id);
      if (out.length > 200) break;
    }
    return out.sort();
  }
  throw new ProviderError('이 종류는 모델 목록을 물어볼 수 없습니다.', 'kind');
}

module.exports = { ask, listModels, KINDS, ProviderError, pickOcrText, UPSTAGE_BASE };
