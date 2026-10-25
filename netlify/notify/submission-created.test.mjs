// フォームの送信が確かめられたときに動く処理（Slack への知らせ）を確かめる。使い方：node --test netlify/notify/*.test.mjs
// Slack には実際には送らない（送る関数 fetch を差し替える）。データと URL はすべて架空。
// このファイルを netlify/functions に置くと、Netlify が外から呼べる処理として公開してしまうため、ここに置く
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { format } from 'node:util';
import handler from '../functions/submission-created.mjs';

const SLACK = 'https://hooks.slack.com/services/TEST/TEST/TEST';
const ORIGINAL = process.env.SLACK_WEBHOOK_URL;

function setEnv(value) {
  if (value === undefined) delete process.env.SLACK_WEBHOOK_URL;
  else process.env.SLACK_WEBHOOK_URL = value;
}
afterEach(() => setEnv(ORIGINAL));

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
  },
};

// 記録（console.error に書いたもの）に、送信の中身（個人の情報）が出ていないこと
function assertNoPersonalData(errorMock) {
  const logged = errorMock.mock.calls.map((call) => format(...call.arguments)).join('\n');
  for (const value of ['架空商事', '架空 太郎', 'taro@example.test', '03-0000-0000', '相談したいです', '203.0.113.9', 'Mozilla']) {
    assert.ok(!logged.includes(value), value);
  }
}

test('Slack の URL が設定されていれば、知らせの文を、5秒の時間切れ付きで1回だけ送る', async (t) => {
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
  assert.equal(sent.text.split('\n')[0], '*新しい問い合わせ（会社のサイト）*');
  assert.equal(sent.text.split('\n')[1], '取引先：架空商事株式会社');
  assert.equal(sent.unfurl_links, false);
  assert.equal(sent.unfurl_media, false);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments),
    [[5000]],
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
  assert.equal(error.mock.callCount(), 1);
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
  assert.equal(error.mock.callCount(), urls.length);
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
  assert.equal(error.mock.callCount(), 1);
  assertNoPersonalData(error);
});

test('Slack に断られたときも、エラーで止まらず、記録に個人の情報を残さない', async (t) => {
  setEnv(SLACK);
  t.mock.method(globalThis, 'fetch', async () => new Response('no_service', { status: 404 }));
  const error = t.mock.method(console, 'error', () => {});
  const res = await handler(event(submission));
  assert.equal(res.status, 200);
  assert.equal(error.mock.callCount(), 1);
  assert.ok(format(...error.mock.calls[0].arguments).includes('404'));
  assertNoPersonalData(error);
});
