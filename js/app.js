/* 문제풀이도구 — 화면
 *
 * 화면은 상태를 스스로 갖지 않는다. 무엇을 하든 서버에 알리고, 서버가 돌려준
 * 모습을 다시 그린다. 그래야 화면에 보이는 것과 실제로 AI 에게 가는 것이 같다.
 *
 * ★ API 키는 **넣을 때만** 서버로 간다. 서버가 돌려주는 것은 언제나 가린 값이라,
 *   이 파일은 키 원문을 볼 일이 없다.
 */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let ENV = null;          // 서버가 준 마지막 모습
let region = null;       // 지금 고른 영역(없으면 창 전체)
let running = false;
let shownPage = 0;       // 여러 장 찍었을 때 지금 보고 있는 장

/* ── 서버와 이야기 ─────────────────────────────────────────────────── */

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try {
    r = await fetch(path, opt);
  } catch (e) {
    /* 여기로 오면 브라우저가 내놓는 말은 "Failed to fetch" 뿐이다 —
     * 영문인 데다 까닭도 안 알려 준다. 우리 말로 바꿔 준다. */
    throw new Error('서버와 말이 끊겼습니다. 창을 새로 고쳐 보세요.');
  }
  if (!r.ok) throw new Error('서버가 ' + r.status + ' 로 답했습니다');
  return r.json();
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, bad ? 5200 : 2600);
}

/* ── 그리기 ────────────────────────────────────────────────────────── */

function render(env) {
  if (!env) return;
  ENV = env;
  drawWindows();
  drawAis();
  drawShot();
  drawResult();
}

function drawWindows() {
  const sel = $('#win-list');
  const keep = sel.value || (ENV.settings && ENV.settings.lastHwnd) || '';
  sel.innerHTML = '';
  const wins = ENV.windows || [];
  if (!wins.length) {
    sel.appendChild(new Option('— [목록 새로 고침] 을 눌러 주세요 —', ''));
  } else {
    for (const w of wins) {
      const size = w.cw + '×' + w.ch;
      const mark = w.minimized ? ' (최소화됨)' : '';
      sel.appendChild(new Option(w.title.slice(0, 70) + '   [' + size + ']' + mark, w.hwnd));
    }
  }
  if (keep && wins.some((w) => w.hwnd === keep)) sel.value = keep;
}

function drawAis() {
  const box = $('#ai-list');
  box.innerHTML = '';
  const kinds = ENV.kinds || {};

  for (const p of ENV.settings.providers) {
    const kind = kinds[p.kind] || {};
    const row = el('div', 'ai' + (p.enabled ? ' on' : ''));
    row.dataset.id = p.id;

    /* 켜기 */
    const on = el('input');
    on.type = 'checkbox';
    on.checked = !!p.enabled;
    on.onchange = () => saveProvider(p.id, { enabled: on.checked });
    row.appendChild(on);

    /* 이름 */
    const name = el('div');
    name.appendChild(el('div', 'name', p.label));
    const k = el('div', 'kind', kind.label || p.kind);
    if (kind.seesImage === false) {
      k.title = '이 AI 는 그림을 못 읽습니다. 그림에서 글자를 뽑아 넣어 줍니다 — '
        + '그래프 모양이나 도형처럼 그림으로만 알 수 있는 것은 불리합니다.';
    }
    name.appendChild(k);
    row.appendChild(name);

    /* 칸들 */
    const f = el('div', 'fields');

    if (kind.needsUrl) {
      const url = el('input', 'url');
      url.type = 'text';
      url.placeholder = '주소 (예: https://내서버/v1)';
      url.value = p.baseUrl || '';
      url.onchange = () => saveProvider(p.id, { baseUrl: url.value.trim() });
      f.appendChild(url);
    }

    const model = el('input', 'model');
    model.type = 'text';
    model.placeholder = '모델 이름';
    model.value = p.model || '';
    model.setAttribute('list', 'models-' + p.id);
    model.onchange = () => saveProvider(p.id, { model: model.value.trim() });
    f.appendChild(model);

    const dl = el('datalist');
    dl.id = 'models-' + p.id;
    f.appendChild(dl);

    const pick = el('button', 'ghost', '모델 목록');
    pick.onclick = () => loadModels(p.id, dl, model);
    f.appendChild(pick);

    /* 키 */
    const key = el('input');
    key.type = 'password';
    key.placeholder = p.hasKey ? '키 바꾸려면 여기에' : 'API 키를 붙여 넣으세요';
    key.autocomplete = 'off';
    key.onchange = () => {
      const v = key.value.trim();
      if (!v) return;
      key.value = '';
      saveProvider(p.id, { apiKey: v });
    };
    f.appendChild(key);

    if (p.hasKey) {
      f.appendChild(el('span', 'keystate has', '키 있음 ' + p.keyHint));
      const forget = el('button', 'link', '지우기');
      forget.onclick = async () => {
        if (!confirm(p.label + ' 의 API 키를 지울까요?')) return;
        render(await api('/api/forget-key', { id: p.id }));
        toast('키를 지웠습니다');
      };
      f.appendChild(forget);
    } else {
      f.appendChild(el('span', 'keystate no', '키 없음'));
    }

    /* 줄 지우기 — 마지막 한 줄은 서버가 막는다 */
    if (ENV.settings.providers.length > 1) {
      const del = el('button', 'link rowdel', '줄 지우기');
      del.onclick = async () => {
        if (!confirm('"' + p.label + '" 줄을 지울까요? 저장한 키도 함께 없어집니다.')) return;
        const r = await api('/api/remove-provider', { id: p.id });
        if (!r.ok) { toast(r.message, true); return; }
        render(r);
        toast('지웠습니다');
      };
      f.appendChild(del);
    }

    /* 그림을 못 읽는 갈래는 "그림 → 글자" 를 무엇으로 할지 고른다 */
    if (kind.seesImage === false) {
      const lab = el('label', 'small');
      lab.appendChild(el('span', null, '글자 뽑기'));
      const ocr = el('select');
      for (const [v, t] of [['document-parse', '문서 구조까지 (권장)'], ['ocr', '글자만 빠르게']]) {
        ocr.appendChild(new Option(t, v));
      }
      ocr.value = p.ocrModel || 'document-parse';
      ocr.onchange = () => saveProvider(p.id, { ocrModel: ocr.value });
      lab.appendChild(ocr);
      f.appendChild(lab);
    }

    /* Claude 만 생각하기·힘 조절이 있다 */
    if (kind.canThink) {
      const lab = el('label', 'small');
      const think = el('input');
      think.type = 'checkbox';
      think.checked = p.think !== false;
      think.onchange = () => saveProvider(p.id, { think: think.checked });
      lab.appendChild(think);
      lab.appendChild(el('span', null, '생각하기'));
      f.appendChild(lab);

      const eff = el('select');
      for (const v of ['low', 'medium', 'high', 'xhigh', 'max']) eff.appendChild(new Option(v, v));
      eff.value = p.effort || 'high';
      eff.onchange = () => saveProvider(p.id, { effort: eff.value });
      f.appendChild(eff);
    }

    row.appendChild(f);
    box.appendChild(row);
  }

  $('#repeat').value = String(ENV.settings.repeat || 1);
  $('#timeout').value = String(ENV.settings.timeoutSec || 180);
  $('#scroll').checked = ENV.settings.scroll !== false;
  $('#max-pages').value = String(ENV.settings.maxPages || 10);
  $('#max-pages').disabled = ENV.settings.scroll === false;
  $('#wide').value = ENV.settings.wide || 'fit';
  $('#explain').checked = !!ENV.asksWhy;
  if (document.activeElement !== $('#prompt')) $('#prompt').value = ENV.settings.prompt || '';

  /* 더하기 상자의 종류 목록은 서버가 아는 갈래 그대로 */
  const ak = $('#add-kind');
  if (!ak.options.length) {
    for (const [k, v] of Object.entries(kinds)) ak.appendChild(new Option(v.label, k));
    ak.value = 'compatible';
    syncAddForm();
  }
}

/** 더하기 상자에서 "주소" 칸은 필요한 갈래에만 보인다 */
function syncAddForm() {
  const kind = (ENV.kinds || {})[$('#add-kind').value] || {};
  $('#add-url').classList.toggle('hidden', !kind.needsUrl);
}

function drawShot() {
  const wrap = $('#shot-wrap');
  const info = $('#shot-info');

  /* 글자로 뽑아 온 문서를 보고 있는 중이면 그쪽을 보여 준다 */
  const pw = $('#paper-wrap');
  if (ENV.paper && ENV.paper.chars) {
    pw.classList.remove('hidden');
    $('#paper-name').textContent = ENV.paper.name || '올린 문서';
    $('#paper-info').textContent = '글자 ' + ENV.paper.chars.toLocaleString('ko-KR') + '자';
    if (ENV.paper.sample && !$('#paper-sample').textContent) $('#paper-sample').textContent = ENV.paper.sample;
  } else {
    pw.classList.add('hidden');
  }

  if (!ENV.shot) { wrap.classList.add('hidden'); info.textContent = ''; return; }

  wrap.classList.remove('hidden');
  const s = ENV.shot;
  const pages = (s.pages && s.pages.length) ? s.pages : [{ key: 'preview', w: s.w, h: s.h }];
  if (shownPage >= pages.length) shownPage = 0;

  const img = $('#shot-img');
  img.src = '/shot/' + pages[shownPage].key + '.png?t=' + (drawShot._stamp || Date.now());

  /* 여러 장이면 장 고르는 딱지를 붙인다 */
  const tabs = $('#page-tabs');
  tabs.innerHTML = '';
  tabs.classList.toggle('hidden', pages.length < 2);
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const b = el('button', 'pagetab' + (i === shownPage ? ' on' : ''), (i + 1) + '장');
      b.onclick = () => { shownPage = i; drawShot(); };
      tabs.appendChild(b);
    });
  }

  const bits = [];
  if (s.windowTitle) bits.push(s.windowTitle.slice(0, 50));
  if (pages.length > 1) bits.push(pages.length + '장 (' + (shownPage + 1) + '장째 보는 중)');
  const cur = pages[shownPage];
  if (cur.w) bits.push(cur.w + '×' + cur.h);
  if (region) bits.push('고른 부분만 보냅니다');
  if (s.blank) bits.push('⚠ 그림이 비어 있습니다');
  if (s.note) bits.push(s.note);
  info.textContent = bits.join('  ·  ');

  $('#btn-clear-sel').classList.toggle('hidden', !region);
  /* 여러 장일 때는 끌어서 고르기를 막는다 — 장마다 자리가 달라 뜻이 흐려진다 */
  $('#shot-box').style.cursor = pages.length > 1 ? 'default' : 'crosshair';
  $('#shot-hint').classList.toggle('hidden', pages.length > 1);
}

function drawResult() {
  const answersCard = $('#step-answers');
  const gradeCard = $('#step-result');
  const r = ENV.result;
  if (!r || !r.results || !r.results.length) {
    answersCard.classList.add('hidden');
    gradeCard.classList.add('hidden');
    return;
  }
  answersCard.classList.remove('hidden');
  gradeCard.classList.remove('hidden');

  if (document.activeElement !== $('#answer-key') && r.answerKey) $('#answer-key').value = r.answerKey;
  $('#loose').checked = !!r.loose;

  /* ── 3단계 딱지: 채점과 상관없이 "이 AI 가 몇 문항을 어떻게 냈나" ── */
  const cards = $('#ai-cards');
  cards.innerHTML = '';
  for (const p of r.results) {
    const c = el('div', 'scard' + (p.error ? ' fail' : ''));
    const who = el('div', 'who');
    who.appendChild(el('span', null, p.label));
    who.appendChild(el('span', 'model', p.model || ''));
    c.appendChild(who);

    if (p.error) {
      c.appendChild(el('div', 'rate', '실패'));
      c.appendChild(el('div', 'detail', p.error));
    } else {
      const answered = Object.values(p.answers || {}).filter((v) => String(v || '').trim() !== '').length;
      const total = Object.keys(p.answers || {}).length;
      c.appendChild(el('div', 'rate', answered + '문항'));
      const bits = [];
      if (total > answered) bits.push('못 쓴 것 ' + (total - answered) + '개');
      if (p.whyCount) bits.push('근거 ' + p.whyCount + '개');
      c.appendChild(el('div', 'detail', bits.length ? bits.join(' · ') : '답을 냈습니다'));
    }

    const extra = [];
    if (p.usage && (p.usage.in || p.usage.out)) extra.push('토큰 ' + p.usage.in + '→' + p.usage.out);
    if (p.ms) extra.push((p.ms / 1000).toFixed(1) + '초');
    if (p.tries > 1) extra.push(p.okCount + '/' + p.tries + '번 성공');
    if (p.how === 'loose') extra.push('형식 안 지킴');
    if (p.note) extra.push(p.note);
    if (extra.length) c.appendChild(el('div', 'detail', extra.join(' · ')));

    /* 그림을 못 보고 글자로 읽은 AI 는 조건이 다르다 — 눈에 띄게 적는다 */
    if (p.viaText) {
      const w = el('div', 'viatext', '글자로 읽음 — 그림은 못 봤습니다');
      w.title = '이 AI 는 그림을 받지 못해, 그림에서 뽑아 낸 글자만 보고 풀었습니다. '
        + '그래프·도형처럼 그림으로만 알 수 있는 문제는 불리합니다.';
      c.appendChild(w);
    }

    cards.appendChild(c);
  }

  /* ── 4단계 딱지: 정답률 ── */
  const sum = $('#summary');
  sum.innerHTML = '';
  if (!r.grade) {
    sum.appendChild(el('p', 'hint', '아직 채점하지 않았습니다. 위에 정답지를 넣고 [채점하기] 를 누르세요.'));
  } else {
    for (const p of r.results) {
      const g = r.grade.perProvider[p.id];
      const card2 = el('div', 'scard' + (p.error ? ' fail' : ''));
      const who = el('div', 'who');
      who.appendChild(el('span', null, p.label));
      who.appendChild(el('span', 'model', p.model || ''));
      card2.appendChild(who);

      if (p.error) {
        card2.appendChild(el('div', 'rate', '실패'));
        card2.appendChild(el('div', 'detail', p.error));
      } else if (g) {
        card2.appendChild(el('div', 'rate', g.rate + '%'));
        const bar = el('div', 'bar');
        const i = el('i');
        i.style.width = Math.max(0, Math.min(100, g.rate)) + '%';
        bar.appendChild(i);
        card2.appendChild(bar);
        card2.appendChild(el('div', 'detail',
          '맞음 ' + g.right + ' · 틀림 ' + g.wrong + ' · 못 씀 ' + g.blank + ' / ' + g.total + '문항'));
      }
      sum.appendChild(card2);
    }
  }

  /* 표 */
  const nos = (r.grade && r.grade.questions.length) ? r.grade.questions : (r.questions || []);
  const wrap = $('#table-wrap');
  wrap.innerHTML = '';
  if (!nos.length) {
    wrap.appendChild(el('p', 'hint', 'AI 가 답한 문항이 없습니다. 화면이 잘 읽혔는지 그림을 확인해 보세요.'));
    return;
  }

  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', null, '문항'));
  if (r.grade) hr.appendChild(el('th', null, '정답'));
  for (const p of r.results) {
    const th = el('th', null, p.label);
    if (p.viaText) {
      th.appendChild(el('span', 'viamark', ' (글자)'));
      th.title = '이 AI 는 그림을 못 보고 글자로만 읽었습니다';
    }
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  const allMissed = new Set((r.grade && r.grade.allMissed) || []);

  for (const no of nos) {
    const tr = el('tr');
    if (allMissed.has(no)) tr.className = 'allmiss';
    tr.appendChild(el('td', 'qno', no));

    let row = null;
    if (r.grade) {
      row = r.grade.table.find((x) => x.no === no);
      tr.appendChild(el('td', 'key', row ? row.accepted.join(' | ') : ''));
    }

    for (const p of r.results) {
      const given = (p.answers && p.answers[no]) || '';
      const td = el('td', 'ans');
      if (row) {
        const c = row.cells[p.id];
        td.className = 'ans ' + (c.blank ? 'blank' : (c.ok ? 'ok' : 'no'));
        td.textContent = c.blank ? '—' : c.given;
      } else {
        td.textContent = given || '—';
      }

      /* 여러 번 물었는데 답이 흔들렸을 때만 알려 준다.
       * 늘 같은 답이었으면 굳이 적지 않는다 — 표가 지저분해지고,
       * 정작 봐야 할 "흔들린 자리" 가 묻힌다. */
      const ag = p.agree && p.agree[no];
      if (ag && ag.of > 1 && ag.answer && ag.agree < ag.of) {
        const s = el('span', 'agree', ag.agree + '/' + ag.of + '번만');
        s.title = ag.of + '번 물었는데 ' + ag.agree + '번만 이 답이었습니다';
        td.appendChild(s);
      }

      /* 눌러서 "왜 그렇게 봤는지" 열기.
       * 근거가 있는 칸은 점선 밑줄로 알린다 — 글자를 덧붙이면 답이 "3?" 처럼 읽혀
       * 표가 지저분해진다(근거가 다 있는 것이 보통이라 더 그렇다). */
      const hasWhy = !!(p.reasons && p.reasons[no]);
      if (given || hasWhy || p.rawTail) {
        td.classList.add('clickable');
        if (hasWhy) td.classList.add('haswhy');
        td.tabIndex = 0;
        td.title = hasWhy ? '눌러서 근거 보기' : '눌러서 이 문항의 답을 나란히 보기';
        const open = () => openWhy(no, p.id);
        td.onclick = open;
        td.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  const anyWhy = r.results.some((p) => p.reasons && Object.keys(p.reasons).length);
  const tips = [anyWhy
    ? '답을 누르면 그 문항에 대한 AI 들의 근거를 나란히 볼 수 있습니다.'
    : '답을 누르면 그 문항의 답을 나란히 볼 수 있습니다. 근거까지 보려면 [해설도 받기] 를 켜고 다시 돌리세요.'];
  if (!r.grade) tips.push('아래 4단계에서 정답지를 넣으면 이 표에 맞음·틀림이 칠해집니다.');
  if (r.pages > 1) tips.push('창을 굴려 ' + r.pages + '장으로 찍어 물어봤습니다.');
  $('#table-tip').textContent = tips.join(' ');

  if (allMissed.size) {
    wrap.appendChild(el('p', 'hint',
      '모든 AI 가 틀린 문항: ' + [...allMissed].join(', ') +
      ' — 문제가 어려웠거나, 그림에서 그 부분이 잘 안 읽혔을 수 있습니다.'));
  }
}

/* ── 해설 창 ───────────────────────────────────────────────────────── */

/**
 * 한 문항에 대해 **모든 AI 의 답과 근거를 나란히** 보여 준다.
 * 누른 AI 를 맨 위로 올리고 표시해 둔다 — 보고 싶던 것이 바로 눈에 들어오게.
 */
function openWhy(no, focusId) {
  const r = ENV.result;
  if (!r) return;

  const row = r.grade && r.grade.table.find((x) => x.no === no);
  $('#why-title').textContent = no + '번 문항 — AI 들이 뭐라고 했나';

  const body = $('#why-body');
  body.innerHTML = '';

  if (row) {
    const k = el('p', 'whykey');
    k.appendChild(document.createTextNode('정답 '));
    k.appendChild(el('b', null, row.accepted.join(' | ')));
    body.appendChild(k);
  }

  /* 누른 것을 맨 앞으로 */
  const order = [...r.results].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0));

  for (const p of order) {
    const given = (p.answers && p.answers[no]) || '';
    const why = (p.reasons && p.reasons[no]) || '';
    const cell = row && row.cells[p.id];

    const box = el('div', 'whyrow' + (p.id === focusId ? ' focus' : ''));

    const head = el('div', 'whyhead');
    head.appendChild(el('span', 'who', p.label));
    if (p.model) head.appendChild(el('span', 'model', p.model));

    const state = cell ? (cell.blank ? 'blank' : (cell.ok ? 'ok' : 'no')) : '';
    const pick = el('span', 'pick' + (state ? ' ' + state : ''), given || '답 없음');
    head.appendChild(pick);
    if (cell) head.appendChild(el('span', 'model', cell.blank ? '못 씀' : (cell.ok ? '맞음' : '틀림')));
    box.appendChild(head);

    if (p.error) {
      box.appendChild(el('div', 'whytext none', '이 AI 는 답을 받지 못했습니다 — ' + p.error));
    } else if (why) {
      box.appendChild(el('div', 'whytext', why));
    } else {
      box.appendChild(el('div', 'whytext none',
        p.how === 'loose'
          ? '이 AI 는 정해진 형식을 안 지켜서 근거를 따로 뽑지 못했습니다. 아래 원문을 보세요.'
          : '이 AI 는 근거를 적지 않았습니다.'));
    }

    /* 그 AI 가 실제로 뱉은 글 — 의심스러울 때 직접 확인하라고 남겨 둔다 */
    if (p.rawTail) {
      const det = el('details', 'whyraw');
      det.appendChild(el('summary', null, '이 AI 가 쓴 답 원문 보기'));
      det.appendChild(el('pre', null, p.rawTail));
      box.appendChild(det);
    }

    body.appendChild(box);
  }

  $('#why-back').classList.remove('hidden');
  $('#why-close').focus();
}

function closeWhy() { $('#why-back').classList.add('hidden'); }

/* ── 설정 저장 ─────────────────────────────────────────────────────── */

async function saveProvider(id, patch) {
  const providers = ENV.settings.providers.map((p) => {
    if (p.id !== id) return { ...p, apiKey: '' };      // 남의 키는 건드리지 않는다(빈 값 = 그대로)
    return { ...p, apiKey: '', ...patch };
  });
  render(await api('/api/settings', { providers }));
  if (patch.apiKey) toast('키를 저장했습니다');
}

async function saveTop(patch) {
  render(await api('/api/settings', patch));
}

async function loadModels(id, datalist, input) {
  toast('모델 목록을 물어보는 중…');
  const r = await api('/api/models', { id });
  if (!r.ok) { toast(r.message || '가져오지 못했습니다', true); return; }
  datalist.innerHTML = '';
  for (const m of r.models) datalist.appendChild(new Option(m, m));
  toast(r.models.length + '개를 가져왔습니다. 칸을 눌러 고르세요.');
  input.focus();
}

/* ── 창 찍기 ───────────────────────────────────────────────────────── */

async function shoot(useRegion) {
  const hwnd = $('#use-screen').checked ? '' : $('#win-list').value;
  if (!$('#use-screen').checked && !hwnd) { toast('먼저 창을 골라 주세요', true); return; }

  const willScroll = $('#scroll').checked && hwnd && !(useRegion && region);
  $('#btn-shot').disabled = true;
  $('#btn-shot').textContent = willScroll ? '굴려 내리며 찍는 중…' : '찍는 중…';
  if (willScroll) { $('#log').innerHTML = ''; $('#log').classList.remove('hidden'); }

  try {
    shownPage = 0;
    const r = await api('/api/shot', { hwnd, region: useRegion ? region : null, once: !!(useRegion && region) });
    if (!r.ok) { toast(r.message || '찍지 못했습니다', true); return; }
    drawShot._stamp = r.stamp || Date.now();
    render(r);

    const s = r.shot;
    if (s && s.blank) toast('그림이 비어 있습니다 — 이 창은 그림을 안 내주는 것 같습니다', true);
    else if (s && s.pages && s.pages.length > 1) toast(s.pages.length + '장을 찍었습니다');
    else if (willScroll && s && s.note) toast(s.note, true);
  } finally {
    $('#btn-shot').disabled = false;
    $('#btn-shot').textContent = '이 창 찍기';
  }
}

/* 그림 위에서 끌어 영역 고르기 */
function wireSelection() {
  const box = $('#shot-box');
  const img = $('#shot-img');
  const sel = $('#sel-box');
  let start = null;

  const at = (e) => {
    const r = img.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
    };
  };

  box.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    start = at(e);
    sel.classList.remove('hidden');
    sel.style.left = start.x + 'px';
    sel.style.top = start.y + 'px';
    sel.style.width = '0px';
    sel.style.height = '0px';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!start) return;
    const p = at(e);
    sel.style.left = Math.min(start.x, p.x) + 'px';
    sel.style.top = Math.min(start.y, p.y) + 'px';
    sel.style.width = Math.abs(p.x - start.x) + 'px';
    sel.style.height = Math.abs(p.y - start.y) + 'px';
  });

  window.addEventListener('mouseup', async (e) => {
    if (!start) return;
    const p = at(e);
    const s = start;
    start = null;
    sel.classList.add('hidden');

    const w = Math.abs(p.x - s.x), h = Math.abs(p.y - s.y);
    if (w < 12 || h < 12) return;                       // 살짝 누른 것은 무시

    /* 화면에 보이는 크기 → 실제 그림 크기 */
    const scale = img.naturalWidth / img.clientWidth;
    region = {
      x: Math.round(Math.min(s.x, p.x) * scale),
      y: Math.round(Math.min(s.y, p.y) * scale),
      w: Math.round(w * scale),
      h: Math.round(h * scale),
    };
    await shoot(true);                                   // 고른 부분만 다시 찍는다
    toast('고른 부분만 AI 에게 보냅니다');
  });
}

/* ── 돌리기 ────────────────────────────────────────────────────────── */

function logLine(text, cls) {
  const box = $('#log');
  box.classList.remove('hidden');
  const d = el('div', cls || null, text);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

function wireEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch (_) { return; }
    const many = e.of > 1 ? ' (' + e.try + '/' + e.of + '번째)' : '';

    if (e.type === 'page') {
      logLine('· ' + e.page + '장째 찍었습니다 (' + e.w + '×' + e.h + ')', 'dim');
    } else if (e.type === 'run-start') {
      $('#log').innerHTML = '';
      logLine('AI ' + e.count + '곳에 물어봅니다…'
        + (e.pages > 1 ? ' (' + e.pages + '장을 함께 보냅니다)' : ''), 'dim');
    } else if (e.type === 'start') {
      logLine('· ' + e.label + many + ' 에게 보냈습니다', 'dim');
    } else if (e.type === 'done') {
      const how = e.how === 'loose' ? ' · 형식을 안 지켜 줄글에서 읽음' : '';
      const why = e.why ? ' · 해설 ' + e.why + '개' : '';
      logLine('✔ ' + e.label + many + ' — ' + e.count + '문항' + why + ', '
        + (e.ms / 1000).toFixed(1) + '초' + how + (e.note ? ' · ' + e.note : ''), 'ok');
    } else if (e.type === 'fail') {
      logLine('✘ ' + e.label + many + ' — ' + e.error, 'bad');
    } else if (e.type === 'run-done') {
      logLine('끝났습니다. 문항 ' + e.questions + '개를 모았습니다.', 'ok');
    } else if (e.type === 'run-fail') {
      logLine('멈췄습니다: ' + e.message, 'bad');
    }
  };
}

async function doRun() {
  if (running) return;
  running = true;
  $('#btn-run').disabled = true;
  $('#btn-stop').classList.remove('hidden');
  $('#run-note').textContent = '물어보는 중…';
  try {
    const r = await api('/api/run', {});
    if (!r.ok) { toast(r.message || '돌리지 못했습니다', true); return; }
    render(r);
    $('#step-answers').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast(e.message, true);
  } finally {
    running = false;
    $('#btn-run').disabled = false;
    $('#btn-stop').classList.add('hidden');
    $('#run-note').textContent = '';
  }
}

/* ── 채점 ──────────────────────────────────────────────────────────── */

async function doGrade() {
  const r = await api('/api/grade', { answerKey: $('#answer-key').value, loose: $('#loose').checked });
  if (!r.ok) { toast(r.message || '채점하지 못했습니다', true); return; }
  render(r);
  const best = Object.values(r.result.grade.perProvider).sort((a, b) => b.rate - a.rate)[0];
  toast(best ? ('가장 잘 푼 곳: ' + best.label + ' ' + best.rate + '%') : '채점했습니다');
}

/* ── 지난 기록 ─────────────────────────────────────────────────────── */

function drawRuns(list) {
  const box = $('#runs');
  box.innerHTML = '';
  if (!list.length) { box.appendChild(el('p', 'hint', '아직 돌린 기록이 없습니다.')); return; }
  for (const it of list) {
    const row = el('div', 'runrow2');
    row.appendChild(el('span', 'when', new Date(it.at).toLocaleString('ko-KR')));
    row.appendChild(el('span', 'what',
      (it.windowTitle || '(이름 없음)') + ' — ' + it.providers.join(', ') + ' · ' + it.questions + '문항'
      + (it.graded ? ' · 채점함' : '')));

    const open = el('button', 'ghost', '열기');
    open.onclick = async () => {
      const g = await api('/api/load-run', { id: it.id });
      if (!g.ok) { toast(g.message, true); return; }
      drawShot._stamp = Date.now();
      shownPage = 0;
      render(g);
      $('#step-answers').scrollIntoView({ behavior: 'smooth' });
    };
    row.appendChild(open);

    const del = el('button', 'ghost del', '지우기');
    del.title = '이 기록과 그때 찍은 그림을 없앱니다';
    del.onclick = async () => {
      if (!confirm(new Date(it.at).toLocaleString('ko-KR') + ' 기록을 지울까요?\n찍어 둔 그림도 함께 없어집니다.')) return;
      const r = await api('/api/delete-run', { id: it.id });
      if (!r.ok) { toast(r.message || '지우지 못했습니다', true); return; }
      render(r);
      drawRuns(r.runs);
      toast('지웠습니다');
    };
    row.appendChild(del);

    box.appendChild(row);
  }
}

async function loadRuns() {
  const r = await api('/api/runs');
  drawRuns(r.runs || []);
}

/* ── 파일 올리기 ───────────────────────────────────────────────────── */

async function takeFile(file) {
  if (!file) return;
  const note = $('#upload-note');
  const btn = $('#btn-upload');
  btn.disabled = true;
  const step = (s) => { note.textContent = s; };

  try {
    step('여는 중…');
    const got = await window.Upload.handle(file, step);

    if (got.kind === 'pages') {
      step(got.pages.length + '장을 보내는 중…');
      const r = await api('/api/upload-pages', { name: got.name, pages: got.pages });
      if (!r.ok) { toast(r.message || '올리지 못했습니다', true); note.textContent = ''; return; }
      shownPage = 0;
      drawShot._stamp = r.stamp || Date.now();
      render(r);
      note.textContent = got.name + ' — ' + got.pages.length + '장' + (got.note ? ' · ' + got.note : '');
      toast(got.pages.length + '장을 올렸습니다');
    } else {
      const r = await api('/api/upload-doc', { name: got.name, data: got.data });
      if (!r.ok) { toast(r.message || '글자를 뽑지 못했습니다', true); note.textContent = ''; return; }
      render(r);
      note.textContent = got.name + ' — 글자 ' + r.chars.toLocaleString('ko-KR') + '자를 뽑았습니다';
      $('#paper-sample').textContent = r.sample || '';
      toast('문서에서 글자를 뽑았습니다');
    }
  } catch (e) {
    toast(e.message, true);
    note.textContent = '';
  } finally {
    btn.disabled = false;
  }
}

function wireUpload() {
  const input = $('#file-input');
  input.accept = window.Upload.accept;
  $('#btn-upload').onclick = () => input.click();
  input.onchange = () => { const f = input.files[0]; input.value = ''; takeFile(f); };

  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) takeFile(f);
  });

  /* 창 찍기 ↔ 파일 올리기 */
  for (const tab of document.querySelectorAll('.srctab')) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll('.srctab')) t.classList.toggle('on', t === tab);
      const file = tab.dataset.src === 'file';
      $('#src-win').classList.toggle('hidden', file);
      $('#src-file').classList.toggle('hidden', !file);
    };
  }

  $('#btn-clear-upload').onclick = async () => {
    render(await api('/api/clear-upload', {}));
    $('#upload-note').textContent = '';
    toast('치웠습니다');
  };
}

/* ── 붙이기 ────────────────────────────────────────────────────────── */

function wire() {
  $('#btn-wins').onclick = async () => {
    const r = await api('/api/windows', {});
    render(r);
    if (!r.ok) toast(r.message || '창 목록을 읽지 못했습니다', true);
    else toast((r.windows || []).length + '개의 창을 찾았습니다');
  };
  $('#btn-shot').onclick = () => { region = null; shoot(false); };
  $('#btn-clear-sel').onclick = () => { region = null; shoot(false); };
  $('#use-screen').onchange = () => { $('#win-list').disabled = $('#use-screen').checked; };
  $('#scroll').onchange = async (e) => {
    $('#max-pages').disabled = !e.target.checked;
    await saveTop({ scroll: e.target.checked });
    toast(e.target.checked ? '창을 끝까지 굴려 내리며 찍습니다' : '보이는 화면만 한 장 찍습니다');
  };
  $('#max-pages').onchange = (e) => saveTop({ maxPages: Math.max(1, Math.min(30, Number(e.target.value) || 10)) });
  $('#wide').onchange = async (e) => {
    await saveTop({ wide: e.target.value });
    toast({
      fit: '폭이 넘치면 배율을 줄여 맞춥니다',
      side: '폭이 넘치면 옆으로도 찍습니다',
      off: '폭이 넘쳐도 그냥 둡니다 — 오른쪽이 잘릴 수 있습니다',
    }[e.target.value]);
  };

  $('#btn-clear-runs').onclick = async () => {
    if (!confirm('지난 기록을 몽땅 지울까요?\n찍어 둔 그림도 모두 없어집니다. 되돌릴 수 없습니다.')) return;
    const r = await api('/api/clear-runs', {});
    render(r);
    drawRuns(r.runs || []);
    toast(r.removed + '개를 지웠습니다');
  };

  /* AI 줄 더하기 */
  $('#btn-add-ai').onclick = () => {
    const f = $('#add-form');
    f.classList.toggle('hidden');
    if (!f.classList.contains('hidden')) { syncAddForm(); $('#add-label').focus(); }
  };
  $('#add-kind').onchange = syncAddForm;
  $('#add-cancel').onclick = () => $('#add-form').classList.add('hidden');
  $('#add-go').onclick = async () => {
    const r = await api('/api/add-provider', {
      kind: $('#add-kind').value,
      label: $('#add-label').value,
      model: $('#add-model').value,
      baseUrl: $('#add-url').value,
    });
    if (!r.ok) { toast(r.message, true); return; }
    for (const id of ['#add-label', '#add-model', '#add-url']) $(id).value = '';
    $('#add-form').classList.add('hidden');
    render(r);
    toast('AI 줄을 넣었습니다. 키와 모델 이름을 채워 주세요.');
  };
  $('#btn-reset-ai').onclick = async () => {
    if (!confirm('처음 상태(Claude·ChatGPT·Gemini·Upstage·기타)로 되돌릴까요?\n저장한 키는 그대로 남습니다.')) return;
    render(await api('/api/reset-providers', {}));
    toast('처음 상태로 되돌렸습니다');
  };

  /* 해설 받기 */
  $('#explain').onchange = async (e) => {
    const on = e.target.checked;
    let r = await api('/api/explain', { on });
    if (!r.ok && r.needsConfirm) {
      if (!confirm(r.message)) { e.target.checked = !on; return; }
      r = await api('/api/explain', { on, force: true });
    }
    if (!r.ok) { toast(r.message || '바꾸지 못했습니다', true); e.target.checked = !on; return; }
    render(r);
    toast(on ? '이제 왜 그 답인지도 함께 물어봅니다' : '답만 받습니다 — 더 빠르고 쌉니다');
  };

  /* 해설 창 */
  $('#why-close').onclick = closeWhy;
  $('#why-back').onclick = (e) => { if (e.target === $('#why-back')) closeWhy(); };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#why-back').classList.contains('hidden')) closeWhy();
  });

  $('#repeat').onchange = (e) => saveTop({ repeat: Number(e.target.value) });
  $('#timeout').onchange = (e) => saveTop({ timeoutSec: Number(e.target.value) });
  $('#prompt').onchange = (e) => saveTop({ prompt: e.target.value });
  $('#btn-prompt-reset').onclick = async () => { render(await api('/api/reset-prompt', {})); toast('처음 문구로 되돌렸습니다'); };

  $('#btn-run').onclick = doRun;
  $('#btn-stop').onclick = () => api('/api/stop', {}).then(() => toast('멈추라고 알렸습니다'));
  $('#btn-grade').onclick = doGrade;
  $('#loose').onchange = () => { if ($('#answer-key').value.trim()) doGrade(); };

  $('#btn-export').onclick = async () => {
    const r = await api('/api/export', {});
    if (r.cancelled) return;
    if (!r.ok) { toast(r.message || '저장하지 못했습니다', true); return; }
    toast('저장했습니다: ' + r.file);
  };

  $('#btn-runs').onclick = loadRuns;
  $('#btn-folder').onclick = () => api('/api/reveal', {});
  $('#btn-quit').onclick = async () => {
    if (!confirm('문제풀이도구를 끝낼까요?')) return;
    await api('/api/quit', {});
    document.body.innerHTML = '<div style="padding:60px;text-align:center;color:#66748a">끝났습니다. 이 창을 닫아 주세요.</div>';
  };

  $('#btn-theme').onclick = () => {
    document.body.classList.toggle('dark');
    try { localStorage.setItem('quizbench-dark', document.body.classList.contains('dark') ? '1' : '0'); } catch (_) {}
  };
  try { if (localStorage.getItem('quizbench-dark') === '1') document.body.classList.add('dark'); } catch (_) {}
}

(async function start() {
  wire();
  wireUpload();
  wireSelection();
  wireEvents();
  try {
    render(await api('/api/env'));
    /* 창 목록은 도우미를 깨워야 해서 조금 걸린다 — 뒤늦게 채운다 */
    render(await api('/api/windows', {}));
  } catch (e) {
    toast('시작하지 못했습니다: ' + e.message, true);
  }
  loadRuns();
})();
