/* 한 번 돌리기 — 창을 찍고, 고른 AI 들에게 한꺼번에 물어보고, 답을 모은다.
 *
 * 여기서 지키는 것 두 가지.
 *
 *  1. **같은 그림, 같은 지시문.** 사진은 한 번만 찍어 모두에게 똑같이 보낸다.
 *     AI 마다 따로 찍으면 그 사이에 화면이 바뀌어 견주기가 무너진다.
 *
 *  2. **한 AI 가 넘어져도 나머지는 간다.** 키가 틀렸거나 서버가 죽었어도
 *     그 자리만 "실패" 로 남고 표는 그대로 나온다.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const providers = require('./providers');
const grade = require('./grade');

/* ── 창 찍기 ───────────────────────────────────────────────────────── */

/**
 * 고른 창(또는 그 일부)을 PNG 로 찍는다.
 *
 * 최소화된 창은 윈도우가 그리지 않아 빈 그림이 나온다. 그래서 찍기 전에
 * **포커스를 빼앗지 않고** 되살린다(SW_SHOWNOACTIVATE → 맨 뒤로).
 * 사용자가 하던 일을 방해하지 않으면서 그림만 얻어 오는 길이다.
 */
async function capture(native, { hwnd, region, file }) {
  let woke = false;

  if (hwnd) {
    /* 지금도 최소화인지 확인하고, 그렇다면 살며시 깨운다 */
    try {
      const info = await native.call('findwindow', { hwnd }, 8000);
      if (info && info.found && info.minimized) {
        const act = await native.call('activate', { hwnd, restore: true, front: false }, 8000);
        woke = !!(act && act.restored);
        /* 되살아난 창이 스스로를 다 그릴 틈을 준다 */
        if (woke) await new Promise((r) => setTimeout(r, 350));
      }
    } catch (_) { /* 못 깨워도 아래에서 찍어 보고 사실대로 알려 준다 */ }
  }

  const args = { path: file };
  if (hwnd) args.hwnd = hwnd;
  if (region && region.w > 0 && region.h > 0) args.region = region;
  const r = await native.call('capture', args, 20000);

  return {
    path: r.path || file,
    x: r.x, y: r.y, w: r.w, h: r.h,
    blank: !!r.blank,
    woke,
    note: r.note || (woke ? '최소화된 창을 잠깐 되살려 찍었습니다' : ''),
  };
}

/**
 * 창을 굴려 내리며 끝까지 찍는다 — 화면에 다 안 보이는 긴 문제지를 위해.
 *
 * 사람이 하는 일을 그대로 한다: 찍고, 한 화면쯤 내리고, 또 찍고… 더 안 내려가면 멈춘다.
 * 마우스를 빼앗지 않는다 — 그 창에 "굴렸다" 는 쪽지만 보낸다.
 *
 * 두 가지를 조심한다.
 *
 *  1. **언제 끝인지 알아내기.** 문서 끝에 닿으면 아무리 굴려도 그림이 그대로다.
 *     그래서 그림의 지문(해시)을 견줘 **본 적 있는 그림이 또 나오면 끝**으로 본다.
 *     장끼리 겹쳐도 괜찮다 — 같은 문제는 번호로 한 번만 세기 때문이다.
 *
 *  2. **굴리기가 안 먹는 창.** 쪽지를 무시하는 프로그램이 있다. 그러면 둘째 장이
 *     첫 장과 같아서 곧바로 멈춘다. 그 사실을 그대로 알려 준다 — 조용히 한 장만
 *     보내면 사용자는 "왜 뒷 문제를 안 풀지?" 하고 헤매게 된다.
 */
async function captureScrolling(native, { hwnd, region, maxPages, wide, fileFor, onEvent }) {
  const cap = Math.max(1, Math.min(30, maxPages || 10));
  const say = (e) => { if (onEvent) { try { onEvent(e); } catch (_) {} } };
  const mode = wide || 'fit';            // fit(배율 줄여 맞추기) | side(옆으로도 찍기) | off

  let zoomedOut = 0;
  let sideways = false;

  if (hwnd) {
    /* 폭이 넘치면 먼저 손을 쓴다. 안 그러면 오른쪽 문제가 통째로 안 찍힌다. */
    if (mode === 'fit') {
      try { zoomedOut = await fitWidth(native, hwnd, region, fileFor, say); } catch (_) {}
    }
    /* 맨 위(그리고 맨 왼쪽)로 되감는다.
     * 사용자가 문서를 중간까지 옮겨 둔 채로 찍으면 앞쪽 문제가 통째로 빠진다. */
    try { await toStart(native, hwnd, region, fileFor); } catch (_) {}
  }

  const pages = [];
  const seen = new Set();
  let scrolled = false;
  let stopped = '';

  /** 지금 자리를 찍어 목록에 넣는다. 이미 본 그림이면 false. */
  const shoot = async () => {
    const got = await capture(native, { hwnd, region, file: fileFor(pages.length) });
    const buf = fs.readFileSync(got.path);
    const sig = crypto.createHash('sha1').update(buf).digest('hex');
    if (seen.has(sig)) { try { fs.rmSync(got.path, { force: true }); } catch (_) {} return null; }
    seen.add(sig);
    pages.push({ ...got, bytes: buf.length });
    say({ type: 'page', page: pages.length, of: cap, w: got.w, h: got.h, blank: got.blank });
    return got;
  };

  const wheel = async (args) => {
    await native.call('postscroll', Object.assign({ hwnd }, args), 10000);
    await new Promise((r) => setTimeout(r, 420));
  };

  outer:
  for (let rowNo = 0; rowNo < cap; rowNo++) {
    /* ── 한 줄(같은 높이)을 왼쪽부터 오른쪽으로 ── */
    const first = await shoot();
    if (!first) { stopped = pages.length <= 1 ? 'noscroll' : 'end'; break; }
    if (first.blank) { stopped = 'blank'; break; }
    if (pages.length >= cap) { stopped = 'limit'; break; }
    if (!hwnd) { stopped = 'screen'; break; }

    const cx = Math.floor((first.w || 800) / 2);
    const cy = Math.floor((first.h || 600) / 2);

    /* 폭이 넘치고 "옆으로도 찍기" 라면 오른쪽으로 훑는다 */
    if (mode === 'side') {
      for (let col = 0; col < 4; col++) {
        try { await wheel({ x: cx, y: cy, amount: -8, horizontal: true }); }
        catch (_) { break; }
        const more = await shoot();
        if (!more) break;                       // 더 오른쪽에 새 내용이 없다
        sideways = true;
        if (pages.length >= cap) { stopped = 'limit'; break outer; }
      }
      /* 다음 줄을 위해 맨 왼쪽으로 되돌린다 */
      try { await wheel({ x: cx, y: cy, amount: 40, horizontal: true }); } catch (_) {}
    }

    /* ── 한 화면쯤 내린다 ── */
    try {
      await wheel({ x: cx, y: cy, amount: -10 });
      scrolled = true;
    } catch (_) { stopped = 'cantscroll'; break; }
  }

  if (!stopped && pages.length >= cap) stopped = 'limit';

  return {
    pages,
    scrolled: scrolled && pages.length > 1,
    sideways,
    zoomedOut,
    stopped,
    note: [describeStop(stopped, pages.length),
      zoomedOut ? '폭을 맞추려고 배율을 ' + zoomedOut + '칸 줄였습니다' : '',
      sideways ? '폭이 넘쳐서 옆으로도 찍었습니다' : '',
    ].filter(Boolean).join(' · '),
  };
}

/**
 * 오른쪽에 아직 안 보인 내용이 있는가.
 * 옆으로 굴려 보고 그림이 바뀌면 "넘친다" 는 뜻이다. 확인한 뒤 반드시 제자리로 돌려놓는다.
 */
async function overflowsRight(native, hwnd, region, file) {
  const before = await capture(native, { hwnd, region, file });
  const a = crypto.createHash('sha1').update(fs.readFileSync(before.path)).digest('hex');
  const mid = { x: Math.floor((before.w || 800) / 2), y: Math.floor((before.h || 600) / 2) };

  await native.call('postscroll', { hwnd, x: mid.x, y: mid.y, amount: -8, horizontal: true }, 10000);
  await new Promise((r) => setTimeout(r, 380));

  const after = await capture(native, { hwnd, region, file });
  const b = crypto.createHash('sha1').update(fs.readFileSync(after.path)).digest('hex');

  /* 살펴본 자국을 남기지 않는다 */
  await native.call('postscroll', { hwnd, x: mid.x, y: mid.y, amount: 40, horizontal: true }, 10000);
  await new Promise((r) => setTimeout(r, 380));

  return a !== b;
}

/**
 * 폭이 넘치면 **배율을 줄여** 한 화면에 들어오게 한다 (Ctrl + 휠 아래).
 *
 * 왜 배율이냐: 2단 시험지를 옆으로 잘라 찍으면 문제 하나가 두 장에 걸쳐 쪼개진다.
 * 통째로 보이게 만드는 편이 AI 가 읽기에 훨씬 낫다.
 * 다만 너무 줄이면 글자가 뭉개지므로 **들어오는 순간 멈춘다**(최대 6칸).
 *
 * 돌려주는 값: 실제로 줄인 칸수(0이면 원래 다 들어왔거나 배율이 안 먹은 것).
 */
async function fitWidth(native, hwnd, region, fileFor, say) {
  const probe = fileFor('fit');
  let steps = 0;

  for (let i = 0; i < 6; i++) {
    let over;
    try { over = await overflowsRight(native, hwnd, region, probe); }
    catch (_) { break; }
    if (!over) break;                              // 다 들어온다

    const shot = await capture(native, { hwnd, region, file: probe });
    const beforeSig = crypto.createHash('sha1').update(fs.readFileSync(shot.path)).digest('hex');

    try {
      await native.call('postscroll', {
        hwnd, x: Math.floor((shot.w || 800) / 2), y: Math.floor((shot.h || 600) / 2),
        amount: -1, ctrl: true,                    // Ctrl + 휠 아래 = 배율 줄이기
      }, 10000);
    } catch (_) { break; }
    await new Promise((r) => setTimeout(r, 500));

    const after = await capture(native, { hwnd, region, file: probe });
    const afterSig = crypto.createHash('sha1').update(fs.readFileSync(after.path)).digest('hex');
    if (beforeSig === afterSig) break;             // 배율이 안 먹는 창이다 — 더 해 봐야 소용없다

    steps++;
    if (say) say({ type: 'zoom', steps });
  }

  try { fs.rmSync(probe, { force: true }); } catch (_) {}
  return steps;
}

/**
 * 창을 맨 처음 자리(맨 위·맨 왼쪽)로 되감는다.
 *
 * "몇 번 굴리면 맨 위" 를 알 길이 없으므로, **그림이 더 안 바뀔 때까지** 올린다.
 * 이미 맨 위였다면 첫 번에 끝난다(그림이 그대로라서). 아주 긴 문서를 대비해
 * 횟수를 막아 두었다 — 못 올려도 그 자리에서 찍기 시작하면 되지, 여기서 오래 붙잡히면 안 된다.
 */
async function toStart(native, hwnd, region, fileFor) {
  const probe = fileFor('top');
  for (const dir of ['h', 'v']) {                  // 가로 먼저, 그다음 세로
    let last = '';
    for (let i = 0; i < 6; i++) {
      const got = await capture(native, { hwnd, region, file: probe });
      const sig = crypto.createHash('sha1').update(fs.readFileSync(got.path)).digest('hex');
      if (sig === last) break;                     // 더 안 움직인다 = 끝까지 왔다
      last = sig;
      await native.call('postscroll', {
        hwnd,
        x: Math.floor((got.w || 800) / 2),
        y: Math.floor((got.h || 600) / 2),
        amount: 40,                                 // 위로 / 왼쪽으로 (도우미가 40칸까지 받는다)
        horizontal: dir === 'h',
      }, 10000);
      await new Promise((r) => setTimeout(r, 320));
    }
  }
  try { fs.rmSync(probe, { force: true }); } catch (_) {}
}

function describeStop(why, count) {
  /* 둘째 장이 첫 장과 똑같은 경우다. 까닭이 둘인데 밖에서는 구별할 수 없다 —
   * ① 문서가 짧아 더 내려갈 곳이 없거나 ② 이 창이 굴리기 쪽지를 무시하거나.
   * 앞쪽이 훨씬 흔하므로 단정하지 말고 둘 다 말해 준다. */
  if (why === 'noscroll') return '한 화면에 다 들어옵니다 (또는 이 창이 굴리기를 받지 않습니다)';
  if (why === 'cantscroll') return '이 창에 굴리기를 보낼 수 없어, 보이는 만큼만 찍었습니다';
  if (why === 'limit') return '정해 둔 장수(' + count + '장)까지 찍고 멈췄습니다';
  if (why === 'screen') return '화면 전체 모드는 굴리지 않습니다';
  if (why === 'blank') return '빈 그림이 나와 멈췄습니다';
  return '';
}

/**
 * 지금 열려 있는 창 목록. 제목 없는 것과 너무 작은 것(도구 막대 따위)은 걸러 낸다.
 *
 * ★ 최소화된 창은 크기로 거르면 안 된다.
 *   윈도우는 최소화된 창의 크기를 314×50 같은 껍데기 값으로 알려 준다. 그래서
 *   크기 잣대를 그대로 대면 **작업 표시줄에 내려가 있는 창이 통째로 사라진다**
 *   (한글 문서 창이 목록에 안 보이던 까닭이 이것이었다).
 *   최소화된 창은 찍을 때 되살리면 되므로 크기를 따지지 않고 남긴다.
 */
async function listWindows(native) {
  const r = await native.call('windows', {}, 15000);
  const list = (r.list || []).filter((w) => {
    const t = String(w.title || '').trim();
    if (!t) return false;
    if (w.minimized) return true;                 // 크기는 껍데기 값이라 못 믿는다
    if (w.cw < 120 || w.ch < 80) return false;
    return true;
  });
  /* 익숙한 프로그램을 위로 올려 준다 — 찾기 쉽게 */
  const rank = (w) => {
    const c = String(w.cls || ''), t = String(w.title || '');
    if (/Chrome_WidgetWin/.test(c)) return 0;                 // 크롬·엣지·전자문서
    if (/HwpApp|Hwp/.test(c) || /한글|\.hwp/.test(t)) return 0;
    if (/XLMAIN|EXCEL/i.test(c) || /Excel|\.xlsx?/.test(t)) return 0;
    if (/OpusApp|Word/i.test(c)) return 0;
    if (/Acrobat|PDF/i.test(c + t)) return 1;
    return 2;
  };
  list.sort((a, b) => rank(a) - rank(b) || String(a.title).localeCompare(String(b.title)));
  return list;
}

/* ── 여러 AI 에게 한꺼번에 묻기 ─────────────────────────────────────── */

/**
 * 같은 답이 몇 번 나왔는지 세어 가장 잦은 것을 고른다.
 * 여러 번 물어봤을 때 "이 모델이 늘 같은 답을 하는가" 를 보려는 것.
 *
 * 해설도 함께 고른다 — **이긴 답과 같은 시도에서 나온 해설**이어야 한다.
 * 아무거나 집어 오면 "답은 3인데 해설은 4를 고른 까닭" 이 되어 버린다.
 *
 *   tries : [{ answers:{no:답}, reasons:{no:해설} }, …]
 */
function consensus(tries) {
  const out = {};
  const nos = new Set();
  for (const t of tries) for (const k of Object.keys(t.answers || {})) nos.add(k);

  for (const no of nos) {
    const tally = new Map();
    for (const t of tries) {
      const raw = (t.answers || {})[no];
      if (raw == null || String(raw).trim() === '') continue;
      const key = grade.normalize(raw);
      const cur = tally.get(key) || { count: 0, shown: String(raw), why: '' };
      cur.count++;
      /* 해설은 이 답을 낸 시도의 것 중 처음 것을 쓴다 */
      if (!cur.why) {
        const w = (t.reasons || {})[no];
        if (w) cur.why = String(w);
      }
      tally.set(key, cur);
    }
    if (!tally.size) {
      /* 답은 못 냈지만 까닭은 적어 둔 경우 — "보기가 잘려 못 읽었습니다" 같은 것.
       * 이때가 해설이 가장 아쉬운 자리이므로 반드시 살려 둔다. */
      let why = '';
      for (const t of tries) {
        const w = (t.reasons || {})[no];
        if (w) { why = String(w); break; }
      }
      out[no] = { answer: '', agree: 0, of: tries.length, why };
      continue;
    }
    let best = null;
    for (const v of tally.values()) if (!best || v.count > best.count) best = v;
    out[no] = { answer: best.shown, agree: best.count, of: tries.length, why: best.why };
  }
  return out;
}

/**
 * 고른 AI 들에게 그림을 보여 주고 답을 모은다.
 *
 *   picked   : 설정에서 켜 둔 AI 들(키 포함 — 이 프로세스 안에서만 돈다)
 *   onEvent  : 진행 상황을 흘려보낼 곳(SSE). 없어도 된다.
 *
 * 한 AI 에게 여러 번 묻는 경우(repeat>1)에는 순서대로 묻는다 —
 * 같은 곳에 동시에 여러 번 때리면 429 가 나기 쉽다.
 */
async function askAll(picked, { pngs, paper, prompt, timeoutMs, repeat, onEvent, signal }) {
  const times = Math.max(1, Math.min(5, repeat || 1));
  const say = (e) => { if (onEvent) { try { onEvent(e); } catch (_) {} } };

  const jobs = picked.map(async (p) => {
    const tries = [];
    for (let n = 1; n <= times; n++) {
      if (signal && signal.aborted) break;
      say({ type: 'start', id: p.id, label: p.label, try: n, of: times });
      try {
        const r = await providers.ask(p, { pngs, paper, prompt, timeoutMs, signal });
        const parsed = grade.parseAnswers(r.text);
        tries.push({
          ok: true, ms: r.ms, usage: r.usage, model: r.model, note: r.note || '',
          viaText: !!r.viaText,
          text: r.text, answers: parsed.answers, reasons: parsed.reasons,
          how: parsed.how, parseError: parsed.error,
        });
        say({
          type: 'done', id: p.id, label: p.label, try: n, of: times, ms: r.ms,
          count: Object.keys(parsed.answers).length,
          why: Object.keys(parsed.reasons || {}).length,
          how: parsed.how, note: r.note || '',
        });
      } catch (e) {
        tries.push({ ok: false, ms: e.ms || 0, error: e.message, kind: e.kind || 'error', answers: {}, reasons: {} });
        say({ type: 'fail', id: p.id, label: p.label, try: n, of: times, error: e.message, kind: e.kind || 'error' });
      }
    }

    const good = tries.filter((t) => t.ok);
    const merged = consensus(good);

    /* 화면·기록으로 나가는 것: 답과 해설. 원문은 마지막 것 하나만 접어서 남긴다. */
    const answers = {};
    const reasons = {};
    const agree = {};
    for (const [no, v] of Object.entries(merged)) {
      answers[no] = v.answer;
      if (v.why) reasons[no] = v.why;
      agree[no] = { answer: v.answer, agree: v.agree, of: v.of };
    }

    const usage = good.reduce((a, t) => ({ in: a.in + (t.usage.in || 0), out: a.out + (t.usage.out || 0) }), { in: 0, out: 0 });

    return {
      id: p.id, label: p.label, kind: p.kind, model: (good[0] && good[0].model) || p.model,
      think: p.kind === 'anthropic' ? p.think !== false : false,
      effort: p.effort || '',
      tries: tries.length,
      okCount: good.length,
      answers, reasons, agree,
      whyCount: Object.keys(reasons).length,
      /* 이 AI 는 그림을 봤나, 글자로 바꿔 읽었나 — 견줄 때 반드시 알아야 할 차이다 */
      viaText: !!(good[0] && good[0].viaText),
      how: (good[0] && good[0].how) || 'none',
      usage,
      ms: tries.reduce((a, t) => a + (t.ms || 0), 0),
      error: good.length ? '' : ((tries[tries.length - 1] || {}).error || '답을 받지 못했습니다'),
      kind_error: good.length ? '' : ((tries[tries.length - 1] || {}).kind || ''),
      note: (good[0] && good[0].note) || '',
      rawTail: good.length ? String(good[good.length - 1].text || '').slice(0, 4000) : '',
    };
  });

  return Promise.all(jobs);
}

/**
 * 채점 없이도 표를 그릴 수 있게, 모든 AI 의 답에서 문항 번호를 모아 정렬한다.
 * (정답지를 아직 안 넣었을 때 화면이 보여 줄 목록)
 */
function questionNumbers(results) {
  const set = new Set();
  for (const r of results) for (const k of Object.keys(r.answers || {})) set.add(k);
  return [...set].sort((a, b) => {
    const x = Number(a), y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
    return String(a).localeCompare(String(b));
  });
}

module.exports = {
  capture, captureScrolling, toStart, fitWidth, overflowsRight, describeStop,
  listWindows, askAll, consensus, questionNumbers,
};
