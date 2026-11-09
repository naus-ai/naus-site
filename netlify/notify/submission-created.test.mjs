// フォームの送信が確かめられたときに動く処理（CRM の受付窓口への送信と、届かないときだけの Slack の予備の知らせ）を確かめる。使い方：node --test netlify/notify/*.test.mjs
// Slack には実際には送らない（送る関数 fetch を差し替える）。データと URL はすべて架空。
// このファイルを netlify/functions に置くと、Netlify が外から呼べる処理として公開してしまうため、ここに置く
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { format } from 'node:util';
import handler from '../functions/submission-created.mjs';

const SLACK = 'https://hooks.slack.com/services/TEST/TEST/TEST';
const INTAKE = 'https://intake.example.test'; // 架空の受付窓口
const ORIGINAL = { SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL, INTAKE_URL: process.env.INTAKE_URL, INTAKE_KEY: process.env.INTAKE_KEY };
const FALLBACK = '⚠ CRM に送れなかったため、会社のサイトから直接知らせています';

function setVar(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
// Slack の URL を設定する。受付窓口は、既定では未設定（＝送れない）
function setEnv(value, intake = false) {
  setVar('SLACK_WEBHOOK_URL', value);
  setVar('INTAKE_URL', intake ? INTAKE : undefined);
  setVar('INTAKE_KEY', intake ? 'test-intake-key' : undefined);
}
afterEach(() => { for (const [k, v] of Object.entries(ORIGINAL)) setVar(k, v); });

// 受付窓口（status は番号か 'down'）と Slack の偽物。それぞれに送られた要求を log に残す
function services(t, intake) {
  setEnv(SLACK, true);
  const log = { intake: [], slack: [] };
  const fetch = t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input).startsWith(INTAKE)) {
      log.intake.push({ url: String(input), init, body: JSON.parse(init.body) });
      if (intake === 'down') throw new TypeError('fetch failed');
      return new Response('{}', { status: intake });
    }
    log.slack.push({ url: String(input), init, body: JSON.parse(init.body) });
    return new Response('ok');
  });
  return log;
}

// Netlify が送ってくる合図と同じ形（送信の中身 payload を JSON で包んだもの）
function event(payload) {
  return new Request('https://www.naus.co.jp/.netlify/functions/submission-created', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, site: { id: 'test', name: 'test' } }),
  });
}

const submission = {
  form_name: 'contact',
  created_at: '2026-10-25T12:30:00.000Z',
  data: {
    topic: 'AIコンサルについて',
    company: '架空商事株式会社',
    name: '架空 太郎',
    email: 'taro@example.test',
    tel: '03-0000-0000',
    body: '相談したいです。',
    agree: 'on',
    ip: '203.0.113.9',
    user_agent: 'Mozilla/5.0 (test)',
    referrer: 'https://www.naus.co.jp/',
    'form-name': 'contact',
    'bot-field': '',
    utm_source: 'note',
    utm_medium: '',
    utm_campaign: '',
    utm_content: '',
    utm_term: '',
    landing_page: '/',
    referrer_host: 'news.example.test',
  },
  id: 'sub-1',
};

// 記録（console.error に書いたもの）に、送信の中身（個人の情報）が出ていないこと
function assertNoPersonalData(errorMock) {
  const logged = errorMock.mock.calls.map((call) => format(...call.arguments)).join('\n');
  for (const value of ['架空商事', '架空 太郎', 'taro@example.test', '03-0000-0000', '相談したいです', '203.0.113.9', 'Mozilla']) {
    assert.ok(!logged.includes(value), value);
  }
}

test('受付窓口に送れないとき、Slack に「⚠」付きの知らせの文を、4秒の時間切れ付きで1回だけ送る', async (t) => {
  setEnv(SLACK);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const timeout = t.mock.method(AbortSignal, 'timeout');
  const res = await handler(event(submission));
  assert.equal(res.status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, SLACK);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  const sent = JSON.parse(init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['text', 'unfurl_links', 'unfurl_media']);
  assert.equal(sent.text.split('\n')[0], FALLBACK);
  assert.equal(sent.text.split('\n')[1], '*新しい問い合わせ（会社のサイト）*');
  assert.equal(sent.text.split('\n')[2], '取引先：架空商事株式会社');
  assert.equal(sent.unfurl_links, false);
  assert.equal(sent.unfurl_media, false);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments),
    [[4000]],
  );
  assert.equal(init.signal, timeout.mock.calls[0].result);
});

test('SLACK_WEBHOOK_URL がないときは、送らず、エラーで止まらずに受け付けだけ返す', async (t) => {
  setEnv(undefined);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const error = t.mock.method(console, 'error', () => {});
  const res = await handler(event(submission));
  assert.equal(res.status, 200);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 2); // 受付窓口が未設定の記録＋Slack の記録
  assertNoPersonalData(error);
});

test('Slack の Incoming Webhook ではない URL には送らない（設定の間違いで、ほかの送り先に中身を送らない）', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const error = t.mock.method(console, 'error', () => {});
  const urls = [
    '',
    'https://evil.example/services/TEST',
    'http://hooks.slack.com/services/TEST/TEST/TEST',
    'https://hooks.slack.com.evil.example/services/TEST/TEST/TEST',
    'https://hooks.slack.com@evil.example/services/TEST/TEST/TEST',
    'https://evil.example/?https://hooks.slack.com/services/TEST/TEST/TEST',
  ];
  for (const url of urls) {
    setEnv(url);
    const res = await handler(event(submission));
    assert.equal(res.status, 200, url);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), urls.length * 2); // 受付窓口が未設定の記録＋Slack の記録
  assertNoPersonalData(error);
});

test('知らせないフォームの送信は、Slack に送らない', async (t) => {
  setEnv(SLACK);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const res = await handler(event({ ...submission, form_name: 'newsletter' }));
  assert.equal(res.status, 200);
  assert.equal(fetch.mock.callCount(), 0);
});

test('合図の中身が読めないときも、送らず、エラーで止まらずに受け付けだけ返す', async (t) => {
  setEnv(SLACK);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const error = t.mock.method(console, 'error', () => {});
  const res = await handler(
    new Request('https://www.naus.co.jp/.netlify/functions/submission-created', { method: 'POST', body: 'not json' }),
  );
  assert.equal(res.status, 200);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 1);
});

test('Slack につながらないときも、エラーで止まらず、記録に個人の情報を残さない', async (t) => {
  setEnv(SLACK);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const error = t.mock.method(console, 'error', () => {});
  const res = await handler(event(submission));
  assert.equal(res.status, 200);
  assert.equal(error.mock.callCount(), 2); // 受付窓口が未設定の記録＋Slack の記録
  assertNoPersonalData(error);
});

test('Slack に断られたときも、エラーで止まらず、記録に個人の情報を残さない', async (t) => {
  setEnv(SLACK);
  t.mock.method(globalThis, 'fetch', async () => new Response('no_service', { status: 404 }));
  const error = t.mock.method(console, 'error', () => {});
  const res = await handler(event(submission));
  assert.equal(res.status, 200);
  assert.equal(error.mock.callCount(), 2);
  assert.ok(format(...error.mock.calls[1].arguments).includes('404'));
  assertNoPersonalData(error);
});

// ---- 受付窓口への送信 ----

const formEvent = () => event(submission);

test('受付窓口が 201（重複の 200 も）なら、Slack には送らず ok を返す。送る中身は id・page・form-name と欄だけ', async (t) => {
  for (const status of [201, 200]) {
    const log = services(t, status);
    const res = await handler(formEvent());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(log.slack.length, 0);
    const { body, init, url } = log.intake.at(-1);
    assert.equal(url, `${INTAKE}/v1/submit`);
    assert.equal(init.headers['X-Naus-Sender'], 'site');
    assert.equal(body.kind, 'form');
    assert.equal(body.id, 'sub-1');
    assert.equal(body.page, 'https://www.naus.co.jp/');
    assert.equal(body.fields['form-name'], 'contact');
    for (const key of ['topic', 'company', 'name', 'email', 'tel', 'body', 'agree', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'landing_page', 'referrer_host']) {
      assert.ok(key in body.fields, key);
    }
    assert.equal(body.fields.topic, 'AIコンサルについて');
    assert.ok(!('doc_code' in body.fields));
    for (const key of ['ip', 'user_agent', 'referrer', 'bot-field']) assert.ok(!(key in body.fields), key);
    assert.ok(!init.body.includes('203.0.113.9'));
  }
});

test('受付窓口が 500・つながらないときは、Slack に「⚠」付きで1通。お客様側の返事は ok のまま', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const status of [500, 'down']) {
    const log = services(t, status);
    const res = await handler(formEvent());
    assert.equal(res.status, 200);
    assert.equal(log.slack.length, 1);
    assert.equal(log.slack[0].body.text.split('\n')[0], FALLBACK);
  }
});

test('受付窓口が4秒で返事をしないときも、Slack に予備の知らせ（受付窓口4秒＋Slack4秒で、時間の上限10秒に収まる）', async (t) => {
  t.mock.method(console, 'error', () => {});
  setEnv(SLACK, true);
  const slack = [];
  const timeouts = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return real(ms === 4000 && timeouts.length === 1 ? 20 : ms); });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input).startsWith(INTAKE)) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    slack.push(JSON.parse(init.body));
    return new Response('ok');
  });
  await handler(formEvent());
  assert.deepEqual(timeouts, [4000, 4000]);
  assert.equal(slack.length, 1);
});

test('知らせないフォームは、受付窓口にも送らない', async (t) => {
  const log = services(t, 201);
  await handler(event({ ...submission, form_name: 'newsletter', data: { ...submission.data, 'form-name': 'newsletter' } }));
  assert.equal(log.intake.length, 0);
  assert.equal(log.slack.length, 0);
});

test('予備の知らせには流入元の7項目が「そのほかの項目」として出る。受付窓口に送れたときは出さない', async (t) => {
  t.mock.method(console, 'error', () => {});
  const log = services(t, 500);
  await handler(formEvent());
  const text = log.slack[0].body.text;
  assert.ok(text.includes('utm_source：note'));
  assert.ok(text.includes('referrer_host：news.example.test'));
  assert.ok(text.includes('landing_page：/'));
  assert.ok(!text.includes('form-name'));
});

test('受付窓口の記録に、個人の情報・鍵・URL を残さない', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  services(t, 500);
  await handler(formEvent());
  assertNoPersonalData(error);
  const logged = error.mock.calls.map((c) => format(...c.arguments)).join('\n');
  assert.ok(!logged.includes('test-intake-key') && !logged.includes('intake.example.test'));
});
