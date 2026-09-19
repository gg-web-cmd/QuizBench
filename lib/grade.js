/* 답 읽어 내기 · 다듬기 · 채점.
 *
 * 이 파일에는 바깥과 이야기하는 것이 없다 — 글자를 넣으면 값이 나오는 함수뿐이다.
 * 그래서 자체 점검이 여기를 마음껏 두드릴 수 있고, 채점 규칙이 조용히 바뀌는 일이 없다.
 *
 * 세 가지 일을 한다.
 *   1. parseAnswers()  AI 가 뱉은 글에서 {번호 → 답} 을 캐낸다
 *   2. normalize()     "③", "３", "정답: 3번" 을 모두 "3" 으로 만든다
 *   3. grade()         정답지와 대조해 맞은 개수를 센다
 */
'use strict';

/* ── 1. 다듬기 ─────────────────────────────────────────────────────── */

/* 동그라미 숫자들 — 시험지에서 실제로 쓰이는 것만 */
const CIRCLED = {
  '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5',
  '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10',
  '❶': '1', '❷': '2', '❸': '3', '❹': '4', '❺': '5',
  '⓵': '1', '⓶': '2', '⓷': '3', '⓸': '4', '⓹': '5',
  '㉠': '1', '㉡': '2', '㉢': '3', '㉣': '4', '㉤': '5',
};

/** 전각(１Ａ) 을 반각(1A) 으로 */
function toHalfWidth(s) {
  return String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

/** 동그라미 숫자를 보통 숫자로 */
function uncircle(s) {
  let out = '';
  for (const ch of String(s)) out += (CIRCLED[ch] != null ? CIRCLED[ch] : ch);
  return out;
}

/**
 * 견주기 위한 모습으로 만든다.
 *
 *   "③"        → "3"
 *   " 정답: 4번 " → "4"
 *   "３．１４"   → "3.14"
 *   "Seoul"     → "SEOUL"
 *
 * 뜻이 같은데 모양만 다른 것들을 한 자리에 모으는 것이 목적이다.
 * 너무 세게 뭉개면 "1" 과 "10" 이 같아지므로, 숫자 사이는 건드리지 않는다.
 */
function normalize(v) {
  let s = uncircle(toHalfWidth(v == null ? '' : String(v)));
  s = s.replace(/\s+/g, ' ').trim();
  /* 앞에 붙는 말버릇을 떼어 낸다 */
  s = s.replace(/^(정답|답|answer|ans)\s*[:：.]?\s*/i, '');
  /* 뒤에 붙는 "번"·"번째"·마침표 */
  s = s.replace(/\s*(번째|번|호)\s*$/g, '');
  s = s.replace(/[.。]+$/g, '');
  /* 따옴표·괄호 껍데기 */
  s = s.replace(/^["'“”‘’\(\[]+/, '').replace(/["'“”‘’\)\]]+$/, '');
  s = s.trim();
  /* 숫자 하나면 앞의 0 을 떼고(007 → 7), 소수점 끝의 0 도 정리 */
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(n);
  }
  return s.toUpperCase();
}

/** 문제 번호를 다듬는다 — "3번", "３", "문 3" 이 모두 "3" 이 되게 */
function normalizeNo(v) {
  let s = uncircle(toHalfWidth(v == null ? '' : String(v))).trim();
  s = s.replace(/^(문제|문|Q|No\.?|번호)\s*/i, '');
  s = s.replace(/\s*(번|번째|\.|\))\s*$/g, '');
  s = s.trim();
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s.toUpperCase();
}

/* ── 2. AI 가 뱉은 글에서 답 캐내기 ─────────────────────────────────── */

/** ```json … ``` 울타리를 걷어 낸다 */
function stripFence(text) {
  const m = String(text).match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return m ? m[1] : String(text);
}

/**
 * 글 안에서 가장 바깥쪽 { … } 를 찾아 낸다.
 * 앞뒤에 말이 붙어 있어도 JSON 만 건져 내려는 것이다.
 */
function firstJsonObject(text) {
  const s = String(text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * 줄글에서 "번호 답" 짝을 줍는다. JSON 이 아예 없을 때의 마지막 수단이다.
 *
 *   1. 3        1) ④       3번 - 15
 *   2 : 서울     10. 참
 *
 * 한 줄에 하나씩만 인정한다 — "1번 문제의 답은 3" 같은 줄에서 3 을 답으로 본다.
 */
function parseLoose(text) {
  const out = {};
  const lines = String(text).split(/[\r\n]+/);
  for (const raw of lines) {
    /* 전각만 반각으로 편다. 동그라미 숫자는 **그대로 둔다** —
     * 답을 화면에 보여 줄 때 AI 가 쓴 모양 그대로 보이는 편이 낫고,
     * 견줄 때는 normalize() 가 어차피 ③ 과 3 을 같은 것으로 본다. */
    const line = toHalfWidth(raw).trim();
    if (!line) continue;

    /* "1." "2)" "3번" "4번 -" "5 :" 를 모두 번호로 본다 */
    const m = line.match(/^(\d{1,3})\s*(?:번째|번|호)?\s*[.)\]:：\-–—]?\s*(.+)$/);
    if (!m) continue;

    const no = String(parseInt(m[1], 10));
    /* 번호 뒤에 구분 기호가 겹쳐 있으면(예: "3번 - 서울") 마저 떼어 낸다 */
    let ans = m[2].replace(/^[\s.)\]:：\-–—]+/, '').trim();

    /* "문제의 답은 3" 처럼 말이 붙었으면 뒤쪽 토막을 답으로 본다 */
    const tail = ans.match(/(?:정답|답)\s*(?:은|는|이|:|：)?\s*(.+)$/);
    if (tail) ans = tail[1].trim();

    if (ans && out[no] == null) out[no] = ans;
  }
  return out;
}

/**
 * AI 의 답 글 → { 번호: 답 }.
 * 되도록 JSON 으로 읽고, 안 되면 줄글에서 줍는다.
 * 어떤 길로 읽었는지(`how`)도 알려 준다 — 화면에서 "형식을 안 지켰다" 를 보여 주려고.
 */
/** 해설이 적혀 있을 만한 칸 이름들 — 모델마다 조금씩 다르게 부른다 */
const WHY_KEYS = ['why', 'reason', 'reasoning', 'explanation', 'explain', 'because', '이유', '근거', '풀이', '해설'];

function pickWhy(obj) {
  for (const k of WHY_KEYS) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

function parseAnswers(text) {
  const empty = { answers: {}, reasons: {}, how: 'none', error: '' };
  if (!text || !String(text).trim()) return { ...empty, error: '답이 비어 있습니다' };

  const tryJson = (raw) => {
    let j;
    try { j = JSON.parse(raw); } catch (_) { return null; }
    if (!j || typeof j !== 'object') return null;

    const answers = {};
    const reasons = {};
    const push = (no, ans, why) => {
      const k = normalizeNo(no);
      if (!k || answers[k] != null) return;
      answers[k] = ans == null ? '' : String(ans);
      if (why) reasons[k] = String(why).slice(0, 2000);
    };
    /* 한 항목에서 답과 해설을 함께 꺼낸다 */
    const fromItem = (it) => {
      const no = it.no != null ? it.no : (it.number != null ? it.number : it['번호']);
      const ans = it.answer != null ? it.answer : (it.ans != null ? it.ans : it['답']);
      push(no, ans, pickWhy(it));
    };

    const list = Array.isArray(j.answers) ? j.answers : (Array.isArray(j) ? j : null);
    if (list) {
      for (const it of list) if (it && typeof it === 'object') fromItem(it);
      return { answers, reasons };
    }
    /* {"answers":{"1":"3"}} 또는 {"1":{"answer":"3","why":"…"}} */
    const flat = (j.answers && typeof j.answers === 'object') ? j.answers : j;
    for (const [k, v] of Object.entries(flat)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const ans = v.answer != null ? v.answer : (v.ans != null ? v.ans : v['답']);
        push(k, ans, pickWhy(v));
      } else if (typeof v !== 'object') {
        push(k, v, '');
      }
    }
    return { answers, reasons };
  };

  const body = stripFence(text);
  for (const cand of [body.trim(), firstJsonObject(body)]) {
    if (!cand) continue;
    const got = tryJson(cand);
    if (got && Object.keys(got.answers).length) {
      return { answers: got.answers, reasons: got.reasons, how: 'json', error: '' };
    }
  }

  const loose = parseLoose(body);
  if (Object.keys(loose).length) return { answers: loose, reasons: {}, how: 'loose', error: '' };

  return { ...empty, error: '답에서 문항을 찾지 못했습니다' };
}

/* ── 3. 정답지 ─────────────────────────────────────────────────────── */

/**
 * 사람이 적은 정답지를 { 번호: [답, 답…] } 으로 읽는다.
 * 받아 주는 모양:
 *
 *   1 3            줄마다 번호와 답
 *   2. ④
 *   3: 15
 *   4 3|4          둘 중 아무거나 맞음
 *   1.3 2.4 3.1    한 줄에 여러 개
 *   3,4,1,2,5      번호 없이 답만 (1번부터 차례로)
 */
/**
 * 어느 모양인지 가르는 규칙 — 헷갈리지 않게 못을 박아 둔다.
 *
 *   여러 줄이면          → 줄마다 "번호 답" 으로 읽는다
 *   한 줄에 짝이 둘 이상  → "1.3 2.4 3.1" 로 읽는다
 *   한 줄인데 구분 기호가 또렷하면 → 그 하나로 읽는다 ("7. 서울")
 *   그 밖의 한 줄        → 번호 없이 답만 늘어놓은 것으로 본다
 *
 * "3 4 1" 처럼 한 줄에 번호도 기호도 없는 것은 답 목록이다.
 * 번호를 매기려면 줄을 나누거나 "1. 3" 처럼 점을 찍어야 한다.
 */
function parseKey(text) {
  const src = String(text == null ? '' : text).trim();
  if (!src) return {};

  const out = {};
  const setKey = (no, ans) => {
    const k = normalizeNo(no);
    if (!k) return;
    const list = String(ans).split(/\s*(?:\||또는|or)\s*/i).map((x) => x.trim()).filter(Boolean);
    if (list.length) out[k] = list;
  };

  const lines = src.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);

  /** 한 줄에서 "번호 + 답" 짝들을 캐낸다. 못 캐면 빈 배열. */
  const pairsIn = (line) => {
    const flat = toHalfWidth(line);
    /* "1.3 2.4 3.1" — 기호로 붙은 짝이 둘 이상 */
    const many = [...flat.matchAll(/(\d{1,3})\s*[.)\]:：]\s*([^\s,;]+)/g)];
    if (many.length >= 2) return many.map((m) => [m[1], m[2]]);
    /* "1. 3" · "2) ④" · "3번 - 서울" · "4 3|4" */
    const one = flat.match(/^(\d{1,3})\s*(?:번째|번|호)?\s*[.)\]:：\-–—]\s*(.+)$/)
      || flat.match(/^(\d{1,3})\s*(?:번째|번|호)\s+(.+)$/)
      || flat.match(/^(\d{1,3})\s+(.+)$/);
    return one ? [[one[1], one[2].replace(/^[\s.)\]:：\-–—]+/, '')]] : [];
  };

  if (lines.length >= 2) {
    for (const line of lines) for (const [no, ans] of pairsIn(line)) setKey(no, ans);
    if (Object.keys(out).length) return out;
  } else {
    const flat = toHalfWidth(lines[0] || '');
    const many = [...flat.matchAll(/(\d{1,3})\s*[.)\]:：]\s*([^\s,;]+)/g)];
    if (many.length >= 2) {
      for (const m of many) setKey(m[1], m[2]);
      return out;
    }
    /* 구분 기호가 또렷한 한 줄짜리 — "7. 서울" */
    const one = flat.match(/^(\d{1,3})\s*(?:번째|번|호)?\s*[.)\]:：]\s*(.+)$/);
    if (one) { setKey(one[1], one[2]); return out; }
  }

  /* 번호 없이 답만 늘어놓은 것 — 1번부터 차례로 매긴다 */
  const items = src.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  items.forEach((a, i) => setKey(String(i + 1), a));
  return out;
}

/* ── 4. 채점 ───────────────────────────────────────────────────────── */

/**
 * 답 하나가 정답지의 어느 하나와 맞는가.
 * `loose` 를 켜면 서술형에서 "정답이 답 안에 들어 있으면" 맞은 것으로 친다.
 */
function isCorrect(given, accepted, loose) {
  const g = normalize(given);
  if (!g) return false;
  for (const a of accepted) {
    const k = normalize(a);
    if (!k) continue;
    if (g === k) return true;
    /* 숫자는 값으로 견준다 — "3.0" 과 "3" */
    const gn = Number(g), kn = Number(k);
    if (Number.isFinite(gn) && Number.isFinite(kn) && gn === kn) return true;
    if (loose && k.length >= 2 && g.includes(k)) return true;
  }
  return false;
}

/**
 * 여러 AI 의 답을 정답지와 대조한다.
 *
 *   results : [{ id, label, answers: {번호: 답} }, …]
 *   key     : { 번호: [답…] }
 *
 * 돌려주는 것
 *   questions   : 채점한 문항 번호(정답지 차례대로)
 *   perProvider : AI 별 { 맞음, 틀림, 못 씀, 정답률 }
 *   table       : 문항 × AI 표 — 화면이 그대로 그린다
 */
function grade(results, key, opts) {
  const loose = !!(opts && opts.loose);
  const nos = Object.keys(key).sort((a, b) => {
    const x = Number(a), y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
    return String(a).localeCompare(String(b));
  });

  const perProvider = {};
  for (const r of results) perProvider[r.id] = { id: r.id, label: r.label, right: 0, wrong: 0, blank: 0, total: nos.length, rate: 0 };

  const table = nos.map((no) => {
    const row = { no, accepted: key[no], cells: {} };
    for (const r of results) {
      const given = r.answers ? r.answers[no] : undefined;
      const has = given != null && String(given).trim() !== '';
      const ok = has && isCorrect(given, key[no], loose);
      row.cells[r.id] = { given: has ? String(given) : '', ok: ok, blank: !has };
      const p = perProvider[r.id];
      if (!has) p.blank++;
      else if (ok) p.right++;
      else p.wrong++;
    }
    return row;
  });

  for (const p of Object.values(perProvider)) {
    p.rate = p.total ? Math.round((p.right / p.total) * 1000) / 10 : 0;
  }

  /* AI 들이 몰려서 틀린 문항 — 문제 자체가 어려웠거나 화면이 안 읽힌 자리다 */
  const hardest = table
    .map((row) => ({ no: row.no, missed: results.filter((r) => !row.cells[r.id].ok).length }))
    .filter((x) => x.missed === results.length && results.length > 0)
    .map((x) => x.no);

  return { questions: nos, perProvider, table, allMissed: hardest, loose };
}

/* ── 5. 내보내기 ───────────────────────────────────────────────────── */

/**
 * 엑셀에서 바로 열리는 CSV. 앞에 BOM 을 붙여야 한글이 안 깨진다.
 * 해설을 받아 둔 AI 가 하나라도 있으면 "근거" 칸을 뒤에 덧붙인다.
 */
function toCsv(graded, results) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const anyWhy = results.some((r) => r.reasons && Object.keys(r.reasons).length);

  const head = ['문항', '정답', ...results.map((r) => r.label), ...results.map((r) => r.label + ' 채점')];
  if (anyWhy) head.push(...results.map((r) => r.label + ' 근거'));
  const rows = [head.join(',')];

  for (const row of graded.table) {
    const line = [esc(row.no), esc(row.accepted.join(' | '))];
    for (const r of results) line.push(esc(row.cells[r.id].given));
    for (const r of results) {
      const c = row.cells[r.id];
      line.push(c.blank ? '못 씀' : (c.ok ? 'O' : 'X'));
    }
    if (anyWhy) for (const r of results) line.push(esc((r.reasons && r.reasons[row.no]) || ''));
    rows.push(line.join(','));
  }

  rows.push('');
  rows.push(['', '정답률(%)', ...results.map((r) => {
    const p = graded.perProvider[r.id];
    return p ? p.rate : '';
  })].join(','));
  rows.push(['', '맞음', ...results.map((r) => (graded.perProvider[r.id] || {}).right || 0)].join(','));
  rows.push(['', '틀림', ...results.map((r) => (graded.perProvider[r.id] || {}).wrong || 0)].join(','));
  rows.push(['', '못 씀', ...results.map((r) => (graded.perProvider[r.id] || {}).blank || 0)].join(','));

  return '﻿' + rows.join('\r\n');
}

module.exports = {
  toHalfWidth, uncircle, normalize, normalizeNo,
  stripFence, firstJsonObject, parseLoose, parseAnswers, pickWhy, WHY_KEYS,
  parseKey, isCorrect, grade, toCsv,
};
