/* 자체 점검 — 빌드 끝에 exe 를 실제로 돌려 확인한다.
 *
 *   node server.js --selftest
 *
 * 여기서 보는 것은 다섯 가지다.
 *   1. 답 다듬기·채점 셈이 맞는가            (lib/grade.js)
 *   2. **API 키가 화면으로 새지 않는가**     (lib/store.js) ← 이 도구에서 가장 중요하다
 *   3. 네 갈래 AI 통로가 실제로 말이 되는가  (lib/providers.js, 가짜 서버 상대로)
 *   4. 창 목록·창 찍기가 되는가              (native/worker.cs — 진짜로 컴파일해서)
 *   5. 서버가 뜨고 응답에 키가 없는가        (자식 프로세스로 진짜 띄워서)
 *
 * ★ 사용자 자료를 건드리지 않는다.
 *   store.js 는 불러오는 순간 %APPDATA% 를 읽는다. 그래서 **무엇을 불러오기 전에**
 *   APPDATA 를 임시 폴더로 돌려 놓는다. 자식 프로세스에도 같은 값을 물려준다.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/* ── 0. 저장 자리를 임시 폴더로 돌려놓기 (다른 것을 부르기 전에!) ────── */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'quizbench-selftest-'));
const REAL_APPDATA = process.env.APPDATA;
process.env.APPDATA = SANDBOX;

/* 이제 불러도 안전하다 */
const store = require('./store');
const grade = require('./grade');
const providers = require('./providers');
const run = require('./run');
const native = require('./native');
const runtime = require('./runtime');
const peek = require('./peek');

if (!store.APP_DIR.startsWith(SANDBOX)) {
  throw new Error('점검이 사용자 자료를 볼 뻔했습니다: ' + store.APP_DIR);
}

/* ── 작은 확인 도구들 ──────────────────────────────────────────────── */

function want(cond, what) { if (!cond) throw new Error('틀림: ' + what); }
function eq(got, expect, what) {
  const a = JSON.stringify(got), b = JSON.stringify(expect);
  if (a !== b) throw new Error('틀림: ' + what + '\n   받음: ' + a + '\n   기대: ' + b);
}

/* ── 1. 답 다듬기·채점 ─────────────────────────────────────────────── */

function checkGrade() {
  /* 다듬기 — 시험지에서 실제로 만나는 모양들 */
  eq(grade.normalize('③'), '3', '동그라미 숫자');
  eq(grade.normalize('４'), '4', '전각 숫자');
  eq(grade.normalize(' 정답: 3번 '), '3', '말버릇 떼기');
  eq(grade.normalize('답 : ②'), '2', '답: 접두 + 동그라미');
  eq(grade.normalize('007'), '7', '앞의 0');
  eq(grade.normalize('3.0'), '3', '소수점 끝');
  eq(grade.normalize('seoul'), 'SEOUL', '대소문자');
  eq(grade.normalize('"서울"'), '서울', '따옴표 껍데기');
  /* 1 과 10 이 뭉개지면 안 된다 */
  want(grade.normalize('1') !== grade.normalize('10'), '1 과 10 은 달라야 합니다');
  eq(grade.normalize('⑩'), '10', '동그라미 10');

  /* 문항 번호 */
  eq(grade.normalizeNo('3번'), '3', '번호에서 번 떼기');
  eq(grade.normalizeNo('문 12'), '12', '문 접두');
  eq(grade.normalizeNo('05'), '5', '번호 앞의 0');

  /* AI 답 읽어 내기 — 곧은 JSON */
  eq(grade.parseAnswers('{"answers":[{"no":"1","answer":"3"},{"no":"2","answer":"④"}]}').answers,
    { 1: '3', 2: '④' }, '곧은 JSON');

  /* 울타리와 앞말이 붙은 경우 — 실제로 자주 이렇게 온다 */
  const fenced = '알겠습니다. 답입니다.\n```json\n{"answers":[{"no":"1","answer":"5"}]}\n```\n도움이 되었길!';
  eq(grade.parseAnswers(fenced).answers, { 1: '5' }, '울타리 + 앞뒤 말');
  eq(grade.parseAnswers(fenced).how, 'json', '울타리도 json 으로 읽어야 합니다');

  /* {"1":"3"} 처럼 곧바로 짝인 경우 */
  eq(grade.parseAnswers('{"1":"3","2":"4"}').answers, { 1: '3', 2: '4' }, '번호가 곧 열쇠');

  /* JSON 을 아예 안 지킨 경우 — 줄글에서 줍는다 */
  const loose = grade.parseAnswers('1. ③\n2) 15\n3번 - 서울\n4: 정답은 2');
  eq(loose.answers, { 1: '③', 2: '15', 3: '서울', 4: '2' }, '줄글에서 줍기');
  eq(loose.how, 'loose', '줄글로 읽었다고 알려야 합니다');

  want(grade.parseAnswers('').error !== '', '빈 답은 잘못이라고 해야 합니다');
  want(grade.parseAnswers('죄송하지만 읽을 수 없습니다').error !== '', '답이 없으면 잘못이라고 해야 합니다');

  /* 해설(왜 그 답인지) 캐내기 */
  const withWhy = grade.parseAnswers(
    '{"answers":[{"no":"1","answer":"3","why":"세 각의 합이 180도라서"},{"no":"2","answer":"15"}]}');
  eq(withWhy.answers, { 1: '3', 2: '15' }, '해설이 있어도 답은 그대로');
  eq(withWhy.reasons, { 1: '세 각의 합이 180도라서' }, '해설 캐내기');

  /* 모델마다 칸 이름을 다르게 부른다 */
  eq(grade.parseAnswers('{"answers":[{"no":"1","answer":"3","reason":"까닭"}]}').reasons,
    { 1: '까닭' }, 'reason 이라고 써도 알아보기');
  eq(grade.parseAnswers('{"answers":[{"no":"1","answer":"3","이유":"까닭"}]}').reasons,
    { 1: '까닭' }, '한글 칸 이름도 알아보기');

  /* {"1":{"answer":"3","why":"…"}} 처럼 번호가 열쇠이고 값이 묶음인 경우 */
  const nested = grade.parseAnswers('{"1":{"answer":"3","why":"까닭1"},"2":{"answer":"4","why":"까닭2"}}');
  eq(nested.answers, { 1: '3', 2: '4' }, '번호가 열쇠 + 값이 묶음');
  eq(nested.reasons, { 1: '까닭1', 2: '까닭2' }, '그 안의 해설');

  /* 줄글에서 주운 답에는 해설이 없다 — 없다고 정직하게 */
  eq(grade.parseAnswers('1. 3\n2. 4').reasons, {}, '줄글에는 해설 없음');

  /* 정답지 읽기 — 사람이 적는 여러 모양 */
  eq(grade.parseKey('1 3\n2 4\n3 1'), { 1: ['3'], 2: ['4'], 3: ['1'] }, '줄마다 번호 답');
  eq(grade.parseKey('1. ③\n2) ④'), { 1: ['③'], 2: ['④'] }, '점·괄호 + 동그라미');
  eq(grade.parseKey('1.3 2.4 3.1'), { 1: ['3'], 2: ['4'], 3: ['1'] }, '한 줄에 여러 개');
  eq(grade.parseKey('3,4,1'), { 1: ['3'], 2: ['4'], 3: ['1'] }, '번호 없이 답만');
  eq(grade.parseKey('1 3|4\n2 5'), { 1: ['3', '4'], 2: ['5'] }, '둘 중 아무거나');
  eq(grade.parseKey('5. 서울특별시'), { 5: ['서울특별시'] }, '주관식');
  eq(grade.parseKey('3번 - 서울\n4번 - 부산'), { 3: ['서울'], 4: ['부산'] }, '번 + 붙임표');

  /* 한 줄에 기호 없이 늘어놓으면 답 목록이다 — 번호로 읽으면 안 된다 */
  eq(grade.parseKey('3 4 1'), { 1: ['3'], 2: ['4'], 3: ['1'] }, '한 줄 · 기호 없음 = 답 목록');
  /* 줄을 나누면 번호로 읽는다 */
  eq(grade.parseKey('10 3\n11 4'), { 10: ['3'], 11: ['4'] }, '1번부터 시작하지 않아도');

  /* 맞았나 틀렸나 */
  want(grade.isCorrect('③', ['3'], false), '동그라미 3 = 3');
  want(grade.isCorrect('3.0', ['3'], false), '3.0 = 3');
  want(grade.isCorrect(' 정답: 4 ', ['4'], false), '말버릇이 붙어도 맞음');
  want(!grade.isCorrect('1', ['10'], false), '1 은 10 이 아님');
  want(!grade.isCorrect('', ['3'], false), '빈 답은 틀림');
  want(grade.isCorrect('4', ['3', '4'], false), '복수 정답');
  want(!grade.isCorrect('대한민국 서울', ['서울'], false), '엄격하면 포함은 안 쳐 줌');
  want(grade.isCorrect('대한민국 서울', ['서울'], true), '느슨하면 포함도 맞음');

  /* 채점 셈 */
  const results = [
    { id: 'a', label: 'A', answers: { 1: '3', 2: '4', 3: '' } },       // 맞 · 틀 · 못씀
    { id: 'b', label: 'B', answers: { 1: '3', 2: '1', 3: '2' } },       // 맞 · 맞 · 맞
  ];
  const key = { 1: ['3'], 2: ['1'], 3: ['2'] };
  const g = grade.grade(results, key, {});
  eq(g.questions, ['1', '2', '3'], '문항 차례');
  eq(g.perProvider.a.right, 1, 'A 맞은 개수');
  eq(g.perProvider.a.wrong, 1, 'A 틀린 개수');
  eq(g.perProvider.a.blank, 1, 'A 못 쓴 개수');
  eq(g.perProvider.a.rate, 33.3, 'A 정답률');
  eq(g.perProvider.b.right, 3, 'B 맞은 개수');
  eq(g.perProvider.b.rate, 100, 'B 정답률');
  eq(g.allMissed, [], '모두 틀린 문항 없음');

  /* 모두가 틀린 문항은 따로 알려 준다 */
  const g2 = grade.grade(
    [{ id: 'a', label: 'A', answers: { 1: '9' } }, { id: 'b', label: 'B', answers: { 1: '8' } }],
    { 1: ['3'] }, {});
  eq(g2.allMissed, ['1'], '모두 틀린 문항 집어내기');

  /* 문항 차례가 숫자 순이어야 한다 (2 가 10 보다 앞) */
  const g3 = grade.grade([{ id: 'a', label: 'A', answers: {} }], { 10: ['1'], 2: ['1'], 1: ['1'] }, {});
  eq(g3.questions, ['1', '2', '10'], '문항은 숫자 순으로');

  /* 여러 번 물었을 때 — 해설은 **이긴 답과 같은 시도**의 것이어야 한다 */
  const tries = [
    { answers: { 1: '3' }, reasons: { 1: '3인 까닭' } },
    { answers: { 1: '4' }, reasons: { 1: '4인 까닭' } },
    { answers: { 1: '3' }, reasons: { 1: '3인 까닭 또' } },
  ];
  const con = run.consensus(tries);
  eq(con[1].answer, '3', '가장 잦은 답을 고름');
  eq(con[1].agree, 2, '두 번 나옴');
  eq(con[1].why, '3인 까닭', '★ 해설은 이긴 답을 낸 시도의 것이어야 합니다');

  /* 답을 못 냈어도 까닭은 살려야 한다 — "보기가 잘려 못 읽었습니다" 가 여기 온다.
   * 답이 비었다고 해설까지 버리면, 정작 궁금한 자리에서 아무것도 안 남는다. */
  const blank = run.consensus([{ answers: { 7: '' }, reasons: { 7: '보기가 잘려 못 읽었습니다' } }]);
  eq(blank[7].answer, '', '답은 빈 채로');
  eq(blank[7].why, '보기가 잘려 못 읽었습니다', '★ 답이 없어도 까닭은 남아야 합니다');

  /* CSV — 엑셀이 한글을 읽게 BOM 이 있어야 한다 */
  const csv = grade.toCsv(g, results);
  want(csv.charCodeAt(0) === 0xfeff, 'CSV 앞에 BOM');
  want(csv.includes('정답률(%)'), 'CSV 에 정답률 줄');
  want(/\r\n/.test(csv), 'CSV 줄바꿈은 CRLF');
  want(!csv.includes('근거'), '해설이 없으면 근거 칸도 없어야 합니다');

  /* 해설이 있으면 근거 칸이 붙는다 */
  const withR = [{ id: 'a', label: 'A', answers: { 1: '3' }, reasons: { 1: '세 각의 합' } }];
  const csvR = grade.toCsv(grade.grade(withR, { 1: ['3'] }, {}), withR);
  want(csvR.includes('A 근거'), 'CSV 에 근거 칸');
  want(csvR.includes('세 각의 합'), 'CSV 에 해설 내용');

  /* 답에 쉼표가 있어도 칸이 밀리면 안 된다 */
  const csv2 = grade.toCsv(
    grade.grade([{ id: 'a', label: 'A', answers: { 1: '가, 나' } }], { 1: ['가, 나'] }, {}),
    [{ id: 'a', label: 'A' }]);
  want(csv2.includes('"가, 나"'), '쉼표가 든 답은 따옴표로 묶기');

  return '채점 ' + 40 + '가지';
}

/* ── 2. 키가 새지 않는가 ───────────────────────────────────────────── */

function checkSecrets() {
  const SECRET = 'sk-ant-api03-SELFTEST-SECRET-1234567890abcdef';
  store.save({
    providers: store.defaultProviders().map((p) => (p.id === 'claude' ? { ...p, apiKey: SECRET, enabled: true } : p)),
  });

  /* 가린 값 */
  const masked = store.maskKey(SECRET);
  want(!masked.includes('SECRET'), '가린 값에 원문이 남으면 안 됩니다');
  want(masked.endsWith(SECRET.slice(-4)), '끝 네 글자는 보여 줘야 알아봅니다');

  /* 화면으로 나가는 설정 전체를 훑는다 */
  const safe = JSON.stringify(store.safeSettings());
  want(!safe.includes(SECRET), '★ 화면으로 나가는 설정에 키 원문이 있습니다');
  want(safe.includes('"hasKey":true'), '키가 있다는 사실은 알려 줘야 합니다');

  /* 씻어 내기 — SDK 오류 문구에 키가 섞여 나오는 일이 있다 */
  const dirty = '401 Unauthorized: bad key ' + SECRET + ' at https://api.x/v1?key=' + SECRET;
  const clean = store.redact(dirty);
  want(!clean.includes(SECRET), '★ redact 가 키를 지우지 못했습니다');

  /* 저장돼 있지 않은 키라도 생김새로 가린다 */
  want(!store.redact('sk-proj-abcdefghijklmnop123456').includes('abcdefghijklmnop'), '모르는 키도 생김새로 가리기');
  want(!store.redact('AIzaSyA1234567890abcdefghijklmnopqrs').includes('1234567890abcdefghijk'), '구글 키 모양도 가리기');

  /* 저장된 파일에는 원문이 있어야 한다 — 그래야 다음에 쓴다 */
  const onDisk = fs.readFileSync(store.SETTINGS, 'utf8');
  want(onDisk.includes(SECRET), '저장 파일에는 키가 그대로 있어야 다음에 씁니다');

  return '키 가리기 7가지';
}

/* ── 2-2. AI 줄 늘리기·줄이기, 해설 지시문 ─────────────────────────── */

function checkProviderRows() {
  /* 이름표 짓기 — 겹치면 뒤에 숫자를 붙인다.
   * (기본 줄의 이름표는 claude·gpt·gemini·solar·etc 이고, 새로 더하는 줄은
   *  갈래 이름(anthropic·openai…)을 밑동으로 쓴다 — 그래서 서로 안 부딪친다) */
  const base = store.defaultProviders();
  eq(store.newProviderId('openai', base), 'openai', '기본 줄과는 안 겹친다');
  eq(store.newProviderId('anthropic', [{ id: 'anthropic' }]), 'anthropic2', '겹치면 숫자를 붙여야 합니다');
  eq(store.newProviderId('anthropic', [{ id: 'anthropic' }, { id: 'anthropic2' }]), 'anthropic3', '둘째도 겹치면 그다음');

  /* 우리가 잘못 내보냈던 모델 이름은 조용히 갈아 끼운다.
   * 안 그러면 업데이트를 해도 저장된 옛 이름 그대로라 계속 404 가 난다. */
  for (const [dead, alive] of Object.entries(store.RETIRED_MODELS)) {
    eq(store.fillProvider({ id: 'g', kind: 'google', label: 'G', model: dead }).model, alive,
      '못 쓰게 된 이름(' + dead + ')은 새 이름으로 바뀌어야 합니다');
  }
  /* 사용자가 손으로 고른 이름은 건드리지 않는다 */
  eq(store.fillProvider({ id: 'g', kind: 'google', label: 'G', model: 'gemini-2.5-pro' }).model,
    'gemini-2.5-pro', '★ 사용자가 고른 이름은 그대로 둬야 합니다');
  /* 지금 기본값이 못 쓰는 목록에 들어 있으면 안 된다 (스스로 모순) */
  for (const p of store.defaultProviders()) {
    want(!store.RETIRED_MODELS[p.model], '기본값이 못 쓰는 이름이면 안 됩니다: ' + p.model);
  }

  /* 빠진 칸 메우기 */
  const filled = store.fillProvider({ id: 'x', kind: 'openai', label: 'X' });
  eq(filled.model, '', '모델은 빈 값으로');
  eq(filled.enabled, false, '새 줄은 꺼진 채로');
  eq(filled.think, true, '생각하기는 기본 켬');

  /* 지운 줄이 되살아나면 안 된다 — 예전에 그랬다.
   * (seenDefaults 에 이름표가 적혀 있으면 다시 안 올라온다) */
  store.save({
    providers: [store.fillProvider({ id: 'gemini', kind: 'google', label: 'Gemini' })],
    seenDefaults: store.defaultProviders().map((p) => p.id),
  });
  const only = store.reload().providers;      // 껐다 켠 셈 치고 디스크에서 다시
  eq(only.length, 1, '★ 지운 줄이 다음에 되살아나면 안 됩니다');
  eq(only[0].id, 'gemini', '남긴 줄이 그대로');

  /* 반대로, **판이 올라가며 새로 생긴 기본 줄**은 한 번은 들어와야 한다.
   * (Upstage 를 뒤늦게 더했는데 쓰던 사람 화면에 안 나오면 있으나 마나다) */
  const seenSome = ['claude', 'gpt', 'gemini', 'etc'];       // 이것만 본 적 있다고 해 둔다
  const unseen = store.defaultProviders().map((p) => p.id).filter((id) => !seenSome.includes(id));
  want(unseen.length >= 1, '아직 안 본 기본 줄이 있어야 이 검사가 뜻이 있습니다');

  store.save({
    providers: [store.fillProvider({ id: 'claude', kind: 'anthropic', label: 'Claude' })],
    seenDefaults: seenSome,
  });
  const grown = store.reload().providers;
  for (const id of unseen) {
    want(grown.some((p) => p.id === id), '★ 새로 생긴 기본 줄(' + id + ')은 한 번은 들어와야 합니다');
  }
  eq(grown.length, 1 + unseen.length, '안 본 줄만큼만 늘어야 합니다');

  /* 그 뒤에 지우면 이제는 안 올라온다 (본 적 있다고 적혔으므로) */
  store.save({ providers: [store.fillProvider({ id: 'claude', kind: 'anthropic', label: 'Claude' })] });
  eq(store.reload().providers.length, 1, '한 번 본 뒤 지우면 다시 안 올라옵니다');

  /* 해설 지시문 알아보기 */
  want(store.asksWhy(store.PROMPT_WHY), '해설 문구는 해설을 묻는 것으로 봐야 합니다');
  want(!store.asksWhy(store.PROMPT_PLAIN), '답만 받는 문구는 아니어야 합니다');
  want(store.isBuiltinPrompt(store.PROMPT_WHY), '준비된 문구 알아보기 (해설)');
  want(store.isBuiltinPrompt(store.PROMPT_PLAIN), '준비된 문구 알아보기 (답만)');
  want(!store.isBuiltinPrompt('내가 고쳐 쓴 지시문'), '고쳐 쓴 것은 준비된 문구가 아님');
  want(store.PROMPT_WHY.includes('"why"'), '해설 문구는 why 칸을 알려 줘야 합니다');

  /* 되돌리기: 다음 검사들이 기본 줄을 기대하므로 제자리로 */
  store.save({ providers: store.defaultProviders(), prompt: store.DEFAULT_PROMPT });
  eq(store.load().providers.length, store.defaultProviders().length, '되돌리면 기본 줄 수');

  return 'AI 줄 관리 12가지';
}

/* ── 2-3. 올린 문서에서 글자 뽑기 · 기록 지우기 ────────────────────── */

/** 압축하지 않는 zip 한 덩어리를 손으로 짓는다 (docx·hwpx 는 속이 zip 이다) */
function makeZip(entries) {
  const zlibCrc = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const locals = [];
  const central = [];
  let at = 0;
  for (const [name, text] of entries) {
    const nm = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = zlibCrc(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);           // 압축 안 함
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nm, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(at, 42);
    central.push(ch, nm);

    at += lh.length + nm.length + data.length;
  }
  const body = Buffer.concat(locals);
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}

function checkPaperAndRuns() {
  /* ── 문서에서 글자 뽑기 ── */
  const txt = path.join(SANDBOX, '시험지.txt');
  fs.writeFileSync(txt, '1. 1 더하기 1은?\n① 1 ② 2 ③ 3\n2. 대한민국의 수도는?\n', 'utf8');
  const plain = peek.peek(txt, 'txt');
  want(plain.includes('1 더하기 1은'), '텍스트 파일에서 글자 뽑기');
  want(plain.includes('수도는'), '뒷부분까지 뽑아야 합니다');

  /* 워드 문서(속이 zip) — 사용자가 올리겠다고 한 것이 이것이다 */
  const docx = path.join(SANDBOX, '시험지.docx');
  fs.writeFileSync(docx, makeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
      + '<w:p><w:r><w:t>3. 삼각형 내각의 합은?</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>① 90도 ② 180도 ③ 360도</w:t></w:r></w:p>'
      + '</w:body></w:document>'],
  ]));
  const word = peek.peek(docx, 'docx');
  want(word.includes('삼각형 내각의 합'), '워드 문서에서 글자 뽑기: ' + JSON.stringify(word.slice(0, 80)));
  want(word.includes('180도'), '보기까지 뽑아야 합니다');

  /* 뽑을 수 있는 형식인지 미리 가른다 */
  want(peek.canPeek('docx') && peek.canPeek('hwpx') && peek.canPeek('hwp') && peek.canPeek('txt'), '다룰 수 있는 형식');
  want(!peek.canPeek('exe') && !peek.canPeek('zip'), '못 다루는 형식은 미리 막아야 합니다');

  /* 문제지 전체가 들어와야 한다 — 분류용 6000자 제한이 남아 있으면 뒷 문제가 잘린다 */
  const long = path.join(SANDBOX, '긴시험지.txt');
  fs.writeFileSync(long, Array.from({ length: 900 }, (_, i) => (i + 1) + '. 문제입니다.').join('\n'), 'utf8');
  const big = peek.peek(long, 'txt');
  want(big.length > 9000, '★ 긴 문제지가 잘리면 뒷 문제를 못 풉니다 (지금 ' + big.length + '자)');
  want(big.includes('900. 문제입니다'), '★ 마지막 문제까지 들어와야 합니다');

  /* ── 기록 지우기 ── */
  const id = store.nextRunId();
  const shotA = store.shotPath(id);
  const shotB = store.shotPath(id + '-2');
  fs.writeFileSync(shotA, TINY_PNG);
  fs.writeFileSync(shotB, TINY_PNG);
  store.saveRun({ id, at: new Date().toISOString(), shotKeys: [String(id), id + '-2'], results: [], questions: [] });

  want(store.loadRun(id), '기록이 저장돼야 합니다');
  const del = store.deleteRun(id);
  want(del.ok, '기록 지우기: ' + (del.message || ''));
  want(!store.loadRun(id), '기록이 없어져야 합니다');
  want(!fs.existsSync(shotA) && !fs.existsSync(shotB), '★ 찍어 둔 그림도 함께 없어져야 합니다');

  want(!store.deleteRun(id).ok, '없는 기록을 지우면 그렇다고 해야 합니다');
  want(!store.deleteRun('../settings').ok, '★ 폴더를 거슬러 오르는 번호는 막아야 합니다');

  /* 기록에 적힌 그림 이름이 수상하면 그것만 건너뛴다 */
  const id2 = store.nextRunId();
  const keep = path.join(SANDBOX, 'settings-backup.json');
  fs.writeFileSync(keep, '{}', 'utf8');
  store.saveRun({ id: id2, at: new Date().toISOString(), shotKeys: ['../../settings-backup', String(id2)], results: [] });
  store.deleteRun(id2);
  want(fs.existsSync(keep), '★ 그림 이름으로 바깥 파일을 지우면 안 됩니다');

  /* 몽땅 지우기 */
  for (let i = 0; i < 3; i++) {
    const n = store.nextRunId();
    fs.writeFileSync(store.shotPath(n), TINY_PNG);
    store.saveRun({ id: n, at: new Date().toISOString(), results: [] });
  }
  want(store.listRuns(50).length >= 3, '지우기 전에는 기록이 있어야 합니다');

  /* 지금 보고 있는 미리보기는 남겨야 한다 — 지난 기록을 지웠다고 눈앞의 것까지 사라지면 놀란다 */
  fs.writeFileSync(store.shotPath('preview'), TINY_PNG);
  fs.writeFileSync(store.shotPath('preview-2'), TINY_PNG);

  const gone = store.clearRuns();
  want(gone >= 3, '몽땅 지우기가 개수를 알려 줘야 합니다');
  eq(store.listRuns(50).length, 0, '기록이 다 없어져야 합니다');
  want(fs.existsSync(store.shotPath('preview')), '★ 보고 있던 미리보기는 남아야 합니다');
  want(fs.existsSync(store.shotPath('preview-2')), '★ 미리보기 뒷장도 남아야 합니다');
  const left = fs.readdirSync(store.SHOTS_DIR);
  eq(left.filter((f) => !/^preview/.test(f)).length, 0, '기록에 딸린 그림은 다 없어져야 합니다');

  return '문서 글자 뽑기 · 기록 지우기 14가지';
}

/* ── 3. 네 갈래 AI 통로 (가짜 서버 상대로) ─────────────────────────── */

/** 무엇을 물어보든 정해진 답을 주는 가짜 AI 서버 */
function fakeProviderServer() {
  const seen = [];
  const answer = '{"answers":[{"no":"1","answer":"3"},{"no":"2","answer":"4"}]}';
  const server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      let j = null;
      try { j = JSON.parse(body); } catch (_) {}
      seen.push({ url: rq.url, body: j, headers: rq.headers });

      let out;
      if (rq.url.includes('/messages')) {
        out = { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5',
                content: [{ type: 'text', text: answer }], stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 20 } };
      } else if (rq.url.includes('/responses')) {
        out = { id: 'r', object: 'response', status: 'completed', model: 'gpt-test',
                output: [{ type: 'message', role: 'assistant', status: 'completed',
                           content: [{ type: 'output_text', text: answer, annotations: [] }] }],
                usage: { input_tokens: 30, output_tokens: 40 } };
      } else if (rq.url.includes('generateContent')) {
        out = { candidates: [{ content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 60 } };
      } else if (rq.url.includes('/chat/completions')) {
        out = { id: 'c', model: 'etc-test',
                choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 70, completion_tokens: 80 } };
      } else {
        out = { data: [{ id: 'model-a' }, { id: 'model-b' }] };
      }
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(out));
    });
  });
  return { server, seen };
}

/* 1×1 짜리 진짜 PNG — 실제로 실려 가는지 보려고 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function checkProviders() {
  const { server, seen } = fakeProviderServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const table = [
      { id: 'a', kind: 'anthropic', label: 'Claude', model: 'claude-opus-5', apiKey: 'sk-ant-x', baseUrl: base, think: true, effort: 'high' },
      { id: 'o', kind: 'openai', label: 'ChatGPT', model: 'gpt-test', apiKey: 'sk-x', baseUrl: base },
      { id: 'g', kind: 'google', label: 'Gemini', model: 'gemini-test', apiKey: 'k', baseUrl: base },
      { id: 'e', kind: 'compatible', label: '기타', model: 'etc-test', apiKey: 'k', baseUrl: base },
    ];

    for (const p of table) {
      const r = await providers.ask(p, { pngs: [TINY_PNG], prompt: '문제를 풀어라', timeoutMs: 15000 });
      const parsed = grade.parseAnswers(r.text);
      eq(parsed.answers, { 1: '3', 2: '4' }, p.label + ' 의 답을 읽어 내기');
      want(r.usage.in > 0 && r.usage.out > 0, p.label + ' 의 토큰 수');
      want(r.ms >= 0, p.label + ' 의 걸린 시간');
    }

    /* 그림이 정말로 실려 갔는가 — 네 갈래 모두 */
    const b64 = TINY_PNG.toString('base64');
    const bodies = seen.map((s) => JSON.stringify(s.body || {}));
    eq(bodies.filter((b) => b.includes(b64)).length, 4, '네 갈래 모두 그림을 실어 보내야 합니다');

    /* 지시문도 네 갈래 모두 **똑같이** 가야 한다 — 견주기의 전제 */
    eq(bodies.filter((b) => b.includes('문제를 풀어라')).length, 4, '지시문이 모두에게 똑같이 가야 합니다');

    /* 여러 장 보내기 — 굴려 내리며 찍은 문제지가 이 길로 간다.
     * 세 장을 주면 세 장이 다 실려야 하고, 몇 장째인지도 붙어야 한다. */
    const THREE = [TINY_PNG, Buffer.concat([TINY_PNG]), TINY_PNG];
    for (const p of table) {
      seen.length = 0;
      await providers.ask(p, { pngs: THREE, prompt: '풀어라', timeoutMs: 15000 });
      const body = JSON.stringify(seen[0].body || {});
      const hits = body.split(b64).length - 1;
      eq(hits, 3, p.label + ' 에 세 장이 다 실려야 합니다');
      want(body.includes('1번째 장 (전체 3장)'), p.label + ' 에 장 번호 쪽지');
      want(body.includes('3번째 장 (전체 3장)'), p.label + ' 에 마지막 장 번호');
    }

    /* 한 장일 때는 쪽지를 붙이지 않는다 — 쓸데없는 말이 토큰을 먹는다 */
    seen.length = 0;
    await providers.ask(table[0], { pngs: [TINY_PNG], prompt: '풀어라', timeoutMs: 15000 });
    want(!JSON.stringify(seen[0].body).includes('번째 장'), '한 장일 때는 장 번호를 안 붙입니다');

    /* 그림이 없으면 부르기 전에 막는다 */
    let noimg = '';
    try { await providers.ask(table[0], { pngs: [], prompt: 'x', timeoutMs: 5000 }); }
    catch (e) { noimg = e.kind; }
    eq(noimg, 'noimage', '그림 없이 부르면 막아야 합니다');

    /* Claude 쪽만 생각하기 설정이 실린다 */
    const claudeBody = seen.find((s) => s.url.includes('/messages')).body;
    eq(claudeBody.thinking, { type: 'adaptive' }, '켜 두면 적응형 생각하기');
    eq(claudeBody.output_config, { effort: 'high' }, 'effort 실림');
    want(!('fallbacks' in claudeBody), '재는 도구에 대체 모델이 끼면 측정이 어긋납니다');

    /* 생각을 끄면 effort 를 high 위로 올리지 않는다(400 이 난다) */
    seen.length = 0;
    await providers.ask({ ...table[0], think: false, effort: 'max' }, { pngs: [TINY_PNG], prompt: 'x', timeoutMs: 15000 });
    const off = seen[0].body;
    eq(off.thinking, { type: 'disabled' }, '끄면 disabled');
    eq(off.output_config, { effort: 'high' }, '끈 채로는 effort 를 high 까지만');

    /* 모델 목록 */
    const models = await providers.listModels(table[1]);
    eq(models, ['model-a', 'model-b'], '모델 목록');

    /* 키가 없으면 부르기 전에 막는다 */
    let blocked = false;
    try { await providers.ask({ ...table[0], apiKey: '' }, { pngs: [TINY_PNG], prompt: 'x', timeoutMs: 5000 }); }
    catch (e) { blocked = e.kind === 'nokey'; }
    want(blocked, '키가 없으면 부르기 전에 막아야 합니다');

    return 'AI 통로 4갈래';
  } finally {
    server.close();
  }
}

/* ── 3-2. Upstage — 그림을 못 읽어 글자로 바꿔 넣는 길 ─────────────── */

/**
 * Solar 는 그림을 안 받는다. 그래서 이 갈래만 두 걸음이다:
 *   그림 → /document-digitization → 글자 → /chat/completions → 답
 * 가짜 서버로 두 걸음이 실제로 이어지는지, 뽑은 글자가 정말 실려 가는지 본다.
 */
async function checkUpstage() {
  const seen = [];
  const PAPER = '1. 1 더하기 1은?\n① 1 ② 2 ③ 3';

  const server = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: rq.url, type: rq.headers['content-type'] || '', body });

      if (rq.url.includes('/document-digitization')) {
        /* Document Parse 모양으로 돌려준다 */
        rs.writeHead(200, { 'content-type': 'application/json' });
        rs.end(JSON.stringify({ api: '2.0', content: { markdown: PAPER, text: PAPER, html: '<p>' + PAPER + '</p>' } }));
        return;
      }
      if (rq.url.includes('/chat/completions')) {
        rs.writeHead(200, { 'content-type': 'application/json' });
        rs.end(JSON.stringify({
          id: 'c', model: 'solar-pro4',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"answers":[{"no":"1","answer":"2","why":"1+1=2 입니다."}]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 210, completion_tokens: 33 },
        }));
        return;
      }
      rs.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const p = { id: 's', kind: 'upstage', label: 'Solar', model: 'solar-pro4', apiKey: 'up-x', baseUrl: base, ocrModel: 'document-parse' };
    const r = await providers.ask(p, { pngs: [TINY_PNG, TINY_PNG], prompt: '문제를 풀어라', timeoutMs: 15000 });

    eq(grade.parseAnswers(r.text).answers, { 1: '2' }, 'Solar 의 답을 읽어 내기');
    want(r.viaText === true, '★ 글자로 읽었다는 사실을 알려야 합니다');
    want(/글자/.test(r.note || ''), '무엇을 했는지 사람 말로 적어야 합니다');
    eq(r.usage.in, 210, '토큰 수');

    /* 장이 두 개면 글자 뽑기도 두 번 부른다 */
    const ocrCalls = seen.filter((s) => s.url.includes('/document-digitization'));
    eq(ocrCalls.length, 2, '장마다 글자를 뽑아야 합니다');
    want(/multipart\/form-data/.test(ocrCalls[0].type), '그림은 파일로 올려야 합니다');

    /* ★ 뽑아 낸 글이 정말로 풀이 요청에 실렸는가 — 여기가 끊기면 빈 종이를 푸는 셈이다 */
    const chat = seen.find((s) => s.url.includes('/chat/completions'));
    const sent = JSON.parse(chat.body.toString('utf8'));
    const content = sent.messages[0].content;
    want(content.includes('1 더하기 1은?'), '★ 뽑아 낸 글이 풀이 요청에 실려야 합니다');
    want(content.includes('문제를 풀어라'), '지시문도 함께 가야 합니다');
    want(content.includes('1번째 장') && content.includes('2번째 장'), '여러 장이면 장 번호를 붙여야 합니다');
    want(!JSON.stringify(sent).includes(TINY_PNG.toString('base64')), 'Solar 에게 그림을 보내면 안 됩니다(못 읽습니다)');

    /* 글자 뽑기 응답 모양이 통로마다 다르다 — 있을 만한 자리를 다 본다 */
    eq(providers.pickOcrText({ text: '가' }), '가', 'ocr 모양(text)');
    eq(providers.pickOcrText({ content: { markdown: '나' } }), '나', 'document-parse 모양(content.markdown)');
    eq(providers.pickOcrText({ content: { text: '다' } }), '다', 'content.text');
    eq(providers.pickOcrText({ pages: [{ text: '라' }, { text: '마' }] }), '라\n마', 'pages[].text');
    eq(providers.pickOcrText({ elements: [{ content: { markdown: '바' } }] }), '바', 'elements[].content');
    eq(providers.pickOcrText({ 아무것도: 1 }), '', '못 찾으면 빈 글자');

    return 'Upstage 두 걸음(글자 뽑기 → 풀기)';
  } finally {
    server.close();
  }
}

/** 거절·오류가 사람 말로 나오는가 (연결은 하지 않는다) */
async function checkProviderErrors() {
  const server = http.createServer((rq, rs) => {
    if (rq.url.includes('/messages')) {
      /* 거절은 HTTP 200 으로 온다 — 이걸 놓치면 빈 답으로 보인다 */
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [], stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' },
        usage: { input_tokens: 1, output_tokens: 0 },
      }));
      return;
    }
    rs.writeHead(401, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ error: { message: 'invalid key' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    let kind = '';
    try {
      await providers.ask({ id: 'a', kind: 'anthropic', label: 'C', model: 'claude-opus-5', apiKey: 'k', baseUrl: base },
        { pngs: [TINY_PNG], prompt: 'x', timeoutMs: 15000 });
    } catch (e) { kind = e.kind; }
    eq(kind, 'refusal', '거절은 거절이라고 알려야 합니다');

    let msg = '';
    try {
      await providers.ask({ id: 'o', kind: 'openai', label: 'G', model: 'm', apiKey: 'k', baseUrl: base },
        { pngs: [TINY_PNG], prompt: 'x', timeoutMs: 15000 });
    } catch (e) { msg = e.message; }
    want(/키/.test(msg), '401 은 키 이야기로 옮겨야 합니다: ' + msg);

    return '오류 옮기기 2가지';
  } finally {
    server.close();
  }
}

/**
 * 모델 이름이 틀렸을 때 **쓸 수 있는 이름을 그 자리에서 알려 주는가.**
 *
 * 모델 이름은 회사마다 자꾸 바뀐다(옛 것이 문을 닫는다). "이름을 확인하세요" 만으로는
 * 사용자가 어디서 확인할지 모른 채 막힌다 — 실제로 Gemini·Grok 에서 겪은 일이다.
 */
async function checkModelHint() {
  const server = http.createServer((rq, rs) => {
    if (rq.url.includes('/models')) {
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ data: [{ id: 'grok-4.6' }, { id: 'grok-4.3' }, { id: 'text-embedding-3' }] }));
      return;
    }
    /* OpenAI 모양으로 "그런 모델 없다" 를 돌려준다 */
    rs.writeHead(404, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ error: { message: 'The model `groq` does not exist or you do not have access to it.', code: 'model_not_found' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    /* 호환 갈래(생 HTTP) — 사용자가 Grok 자리에 "groq" 를 넣었던 그 경우 */
    let msg = '';
    try {
      await providers.ask({ id: 'x', kind: 'compatible', label: 'Grok', model: 'groq', apiKey: 'k', baseUrl: base },
        { pngs: [TINY_PNG], prompt: 'x', timeoutMs: 15000 });
    } catch (e) { msg = e.message; }
    want(/"groq" 라는 모델이 없습니다/.test(msg), '★ 어떤 이름이 틀렸는지 말해야 합니다: ' + msg);
    want(/grok-4\.6/.test(msg), '★ 쓸 수 있는 이름을 붙여 줘야 합니다: ' + msg);
    want(!/text-embedding/.test(msg), '문제 풀이에 못 쓰는 것은 빼야 합니다');

    /* SDK 갈래(404) 도 같아야 한다 */
    msg = '';
    try {
      await providers.ask({ id: 'o', kind: 'openai', label: 'G', model: '없는모델', apiKey: 'k', baseUrl: base },
        { pngs: [TINY_PNG], prompt: 'x', timeoutMs: 15000 });
    } catch (e) { msg = e.message; }
    want(/없는모델/.test(msg) && /grok-4\.6/.test(msg), '★ SDK 갈래에서도 이름을 알려 줘야 합니다: ' + msg);

    return '모델 이름 알려 주기 4가지';
  } finally {
    server.close();
  }
}

/* ── 4. 창 목록·창 찍기 (진짜 도우미를 컴파일해서) ──────────────────── */

async function checkNative() {
  want(runtime.nativeSource(), '도우미 소스(native/worker.cs)를 exe 에서 꺼내지 못했습니다');

  await native.ensure();
  const list = await run.listWindows(native);
  want(Array.isArray(list), '창 목록이 배열이어야 합니다');

  /* ★ 최소화된 창이 목록에서 사라지면 안 된다.
   * 윈도우는 최소화된 창의 크기를 314×50 같은 껍데기 값으로 준다. 크기로 거르면
   * 작업 표시줄에 내려간 창이 통째로 빠진다(한글 문서 창이 안 보이던 까닭). */
  const raw = await native.call('windows', {}, 15000);
  const minis = (raw.list || []).filter((w) => w.minimized && String(w.title || '').trim());
  for (const m of minis) {
    want(list.some((w) => w.hwnd === m.hwnd),
      '★ 최소화된 창이 목록에서 빠졌습니다: ' + String(m.title).slice(0, 30)
      + ' (' + m.cw + '×' + m.ch + ')');
  }

  /* 화면 전체를 한 조각 찍어 본다 — 창이 하나도 없는 PC 에서도 되게 */
  const file = path.join(SANDBOX, 'shot-test.png');
  const got = await run.capture(native, { hwnd: '', region: { x: 0, y: 0, w: 120, h: 90 }, file });
  want(fs.existsSync(got.path), '찍은 그림 파일이 없습니다');
  const buf = fs.readFileSync(got.path);
  want(buf.length > 100, '찍은 그림이 너무 작습니다');
  want(buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG', '찍은 것이 PNG 가 아닙니다');
  eq([got.w, got.h], [120, 90], '달라고 한 크기로 찍혀야 합니다');

  /* 굴려 내리며 찍기 — 화면 전체 모드는 굴릴 대상이 없으니 한 장에서 멈춰야 한다 */
  const scr = await run.captureScrolling(native, {
    hwnd: '', region: { x: 0, y: 0, w: 100, h: 80 }, maxPages: 5,
    fileFor: (n) => path.join(SANDBOX, 'scroll-' + n + '.png'),
  });
  eq(scr.pages.length, 1, '화면 전체 모드는 한 장이어야 합니다');
  eq(scr.stopped, 'screen', '굴리지 않은 까닭을 알려야 합니다');
  eq(scr.scrolled, false, '굴리지 않았다고 해야 합니다');
  /* 둘째 장이 첫 장과 같을 때는 단정하지 않는다 — 문서가 짧은 경우가 훨씬 흔하다 */
  want(run.describeStop('noscroll', 1).includes('한 화면'), '짧은 문서일 가능성을 먼저 말해야 합니다');
  want(run.describeStop('noscroll', 1).includes('굴리기'), '굴리기가 안 먹었을 가능성도 함께');
  want(run.describeStop('limit', 7).includes('7장'), '장수 제한을 사람 말로');

  /* ★ 여기서 진짜 창을 굴려 보지는 않는다.
   * 굴리기는 **사용자가 보던 창을 실제로 움직인다**. 점검하자고 남의 창을
   * 맨 위로 되감아 놓으면 안 된다. 굴리기 자체는 화면 모드(굴리지 않음)와
   * 멈춤 까닭 문구로 확인하고, 진짜 창에 대고 하는 확인은 사람이 한 번 해 보면 된다. */

  await native.stop();
  return '창 찍기(최소화 창 · 굴려 내리기 포함)';
}

/* ── 5. 서버를 실제로 띄워 보기 ────────────────────────────────────── */

function getJson(port, urlPath, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const rq = http.request({
      host: '127.0.0.1', port, path: urlPath, method: method || 'GET',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (rs) => {
      let s = '';
      rs.on('data', (c) => { s += c; });
      rs.on('end', () => {
        try { resolve({ status: rs.statusCode, json: JSON.parse(s), raw: s }); }
        catch (_) { resolve({ status: rs.statusCode, json: null, raw: s }); }
      });
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

async function checkServer() {
  const SECRET = 'sk-ant-api03-CHILD-SECRET-abcdefghij1234567890';
  const port = 8390 + Math.floor(Math.random() * 200);

  /* 자식에게도 임시 폴더를 물려준다 — 사용자 설정을 안 건드리게 */
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port), '--no-open'], {
    env: { ...process.env, APPDATA: SANDBOX, NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });

  try {
    /* 뜰 때까지 기다린다 */
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { const r = await getJson(port, '/api/env'); up = r.status === 200; } catch (_) {}
    }
    want(up, '서버가 뜨지 않았습니다:\n' + log);

    /* 화면 파일이 나오는가 (exe 안에 박힌 자원까지) */
    for (const f of ['/index.html', '/css/style.css', '/js/app.js']) {
      const r = await getJson(port, f);
      want(r.status === 200 && r.raw.length > 200, '화면 파일이 안 나옵니다: ' + f);
    }

    /* 키를 넣고 → 화면으로 되돌아오는 모든 응답에 원문이 없어야 한다 */
    const saved = await getJson(port, '/api/settings', 'POST', {
      providers: [{ id: 'claude', kind: 'anthropic', label: 'Claude', model: 'claude-opus-5', apiKey: SECRET, enabled: true }],
    });
    want(saved.json.ok, '설정 저장 실패');
    want(!saved.raw.includes(SECRET), '★ 설정 저장 응답에 키가 실려 나왔습니다');

    for (const [p, m, b] of [['/api/env', 'GET', null], ['/api/state', 'GET', null], ['/api/runs', 'GET', null]]) {
      const r = await getJson(port, p, m, b);
      want(!r.raw.includes(SECRET), '★ ' + p + ' 응답에 키가 실려 나왔습니다');
    }

    /* 저장은 실제로 됐는가 */
    const env = await getJson(port, '/api/env');
    const cp = env.json.settings.providers.find((x) => x.id === 'claude');
    want(cp && cp.hasKey === true, '키를 저장했다고 알려 줘야 합니다');
    want(cp.keyHint.endsWith(SECRET.slice(-4)), '가린 값이 보여야 합니다');

    /* 화면 안 찍고 돌리면 얌전히 거절해야 한다 */
    const noShot = await getJson(port, '/api/run', 'POST', {});
    want(noShot.json.ok === false, '그림 없이 돌리면 막아야 합니다');

    /* 정답지 없이 채점하면 얌전히 거절 */
    const noKey = await getJson(port, '/api/grade', 'POST', { answerKey: '' });
    want(noKey.json.ok === false, '정답지 없이 채점하면 막아야 합니다');

    /* 없는 그림을 달라고 하면 404, 폴더를 거슬러 올라가면 안 된다 */
    const noPng = await getJson(port, '/shot/nope.png');
    want(noPng.status === 404, '없는 그림은 404');
    const climb = await getJson(port, '/shot/..%2F..%2Fsettings.png');
    want(climb.status === 404, '폴더를 거슬러 올라가면 안 됩니다');

    /* AI 줄 더하기 — 같은 갈래를 또 넣어도 이름표가 안 겹쳐야 한다 */
    const add1 = await getJson(port, '/api/add-provider', 'POST', { kind: 'anthropic', label: '클로드 빠른 것', model: 'claude-haiku-4-5' });
    want(add1.json.ok, 'AI 줄 더하기 실패: ' + (add1.json.message || ''));
    const add2 = await getJson(port, '/api/add-provider', 'POST', { kind: 'anthropic', label: '클로드 또 하나' });
    want(add2.json.ok, '같은 갈래를 또 더하기');
    want(add1.json.addedId !== add2.json.addedId, '★ 이름표가 겹치면 안 됩니다');

    const after = add2.json.settings.providers;
    eq(after.length, 3, '한 줄 + 더한 두 줄');   // 앞서 설정 저장이 claude 한 줄만 남겼다
    const mine = after.find((p) => p.id === add1.json.addedId);
    eq(mine.label, '클로드 빠른 것', '적어 준 이름표');
    eq(mine.model, 'claude-haiku-4-5', '적어 준 모델');
    eq(mine.enabled, false, '새 줄은 꺼진 채로');

    /* 지우기 */
    const del = await getJson(port, '/api/remove-provider', 'POST', { id: add2.json.addedId });
    want(del.json.ok, '줄 지우기');
    eq(del.json.settings.providers.length, 2, '한 줄이 줄어야 합니다');
    want(!del.json.settings.providers.some((p) => p.id === add2.json.addedId), '지운 줄이 남아 있습니다');

    /* 마지막 한 줄은 못 지운다 */
    await getJson(port, '/api/settings', 'POST', {
      providers: [{ id: 'only', kind: 'google', label: '하나만', model: 'm', apiKey: 'k', enabled: true }],
    });
    const lastDel = await getJson(port, '/api/remove-provider', 'POST', { id: 'only' });
    want(lastDel.json.ok === false, '마지막 한 줄은 막아야 합니다');

    /* 처음 상태로 되돌리기 */
    const reset = await getJson(port, '/api/reset-providers', 'POST', {});
    eq(reset.json.settings.providers.length, store.defaultProviders().length, '되돌리면 기본 줄 수');

    /* 해설 켜고 끄기 */
    const off = await getJson(port, '/api/explain', 'POST', { on: false });
    want(off.json.ok && off.json.asksWhy === false, '해설 끄기');
    want(!off.raw.includes('"why"'), '끄면 지시문에서 why 가 빠져야 합니다');
    const on = await getJson(port, '/api/explain', 'POST', { on: true });
    want(on.json.ok && on.json.asksWhy === true, '해설 켜기');
    want(on.json.settings.prompt.includes('"why"'), '켜면 지시문이 why 를 알려 줘야 합니다');

    /* 고쳐 쓴 지시문은 함부로 덮어쓰지 않는다 */
    await getJson(port, '/api/settings', 'POST', { prompt: '내가 손으로 쓴 지시문입니다' });
    const guard = await getJson(port, '/api/explain', 'POST', { on: true });
    want(guard.json.ok === false && guard.json.needsConfirm, '★ 고쳐 쓴 지시문은 물어보고 바꿔야 합니다');
    const forced = await getJson(port, '/api/explain', 'POST', { on: true, force: true });
    want(forced.json.ok && forced.json.asksWhy, '허락하면 바꾼다');

    return '서버 왕복(키 안 새는지 · AI 줄 관리 · 해설 켜고 끄기)';
  } finally {
    try { child.kill(); } catch (_) {}
  }
}

/* ── 다 함께 ───────────────────────────────────────────────────────── */

async function main() {
  const done = [];
  done.push(checkGrade());
  done.push(checkSecrets());
  done.push(checkProviderRows());
  done.push(checkPaperAndRuns());
  done.push(await checkProviders());
  done.push(await checkUpstage());
  done.push(await checkProviderErrors());
  done.push(await checkModelHint());
  done.push(await checkNative());
  done.push(await checkServer());
  return done;
}

function run_() {
  return main().finally(() => {
    /* 임시 폴더를 치우고 원래 값을 돌려놓는다 */
    if (REAL_APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = REAL_APPDATA;
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  });
}

module.exports = { run: run_ };
