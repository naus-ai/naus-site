// Slack に送る文の作り方を確かめる。使い方：node --test netlify/notify/*.test.mjs（データはすべて架空）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNewLeadMessage, escapeSlack, formatJst } from './new-lead-message.mjs';

const at = '2026-10-25T12:30:00.000Z'; // 日本時間 21:30

// お問い合わせのフォーム（contact）の送信。Netlify が送ってくる中身（payload）の、文に使うところだけ
function contact(data) {
  return { form_name: 'contact', created_at: at, data };
}

// 「見出し：」で始まる行を取り出す（なければ undefined）
function line(text, label) {
  return text.split('\n').find((l) => l.startsWith(label));
}

test('お問い合わせ：見出し・取引先・取引先責任者・メール・電話・受付・内容・そのほかの項目・ページを、この順に載せる', () => {
  // Netlify が送ってくる中身と同じ形（data の項目はフォームの並び順に、Netlify が足す ip・user_agent・referrer が続く）
  const message = buildNewLeadMessage({
    number: 1,
    title: null,
    email: 'taro@example.test',
    name: '架空 太郎',
    first_name: '架空',
    last_name: '太郎',
    company: '架空商事株式会社',
    summary: '<strong>架空 太郎</strong> AI の活用について相談したいです。',
    body: 'AI の活用について相談したいです。',
    data: {
      'form-name': 'contact',
      'bot-field': '',
      topic: 'AIコンサルについて',
      company: '架空商事株式会社',
      name: '架空 太郎',
      email: 'taro@example.test',
      tel: '03-0000-0000',
      body: 'AI の活用について相談したいです。\r\n来月から始めたいです。',
      agree: 'on',
      ip: '203.0.113.9',
      user_agent: 'Mozilla/5.0 (test)',
      referrer: 'https://www.naus.co.jp/',
    },
    created_at: at,
    human_fields: {},
    ordered_human_fields: [],
    id: '000000000000000000000001',
    form_id: '000000000000000000000002',
    site_url: 'https://www.naus.co.jp',
    form_name: 'contact',
  });
  assert.deepEqual(message, {
    text: [
      '*新しい問い合わせ（会社のサイト）*',
      '取引先：架空商事株式会社',
      '取引先責任者：架空 太郎さん',
      'メール：taro@example.test',
      '電話：03-0000-0000',
      '受付：2026/10/25 21:30',
      '内容：AI の活用について相談したいです。',
      '来月から始めたいです。',
      'topic：AIコンサルについて',
      'agree：on',
      'ページ：https://www.naus.co.jp/',
    ].join('\n'),
    unfurl_links: false,
    unfurl_media: false,
  });
});

test('名前などの < > & は逃がし、Slack のメンションやリンクにしない', () => {
  const { text } = buildNewLeadMessage(
    contact({
      topic: '<!subteam^S0000>',
      company: '<!channel> & <https://evil.example|ここ>',
      name: '<@U0000>',
      email: '<mailto:a@evil.example|a@example.test>',
      tel: '<!everyone>',
      body: '<!here>\n<https://evil.example|資料>',
    }),
  );
  assert.ok(!text.includes('<'));
  assert.ok(!text.includes('>'));
  assert.equal(line(text, '取引先：'), '取引先：&lt;!channel&gt; &amp; &lt;https://evil.example|ここ&gt;');
  assert.equal(line(text, '取引先責任者：'), '取引先責任者：&lt;@U0000&gt;さん');
  assert.equal(line(text, 'メール：'), 'メール：&lt;mailto:a@evil.example|a@example.test&gt;');
  assert.equal(line(text, '電話：'), '電話：&lt;!everyone&gt;');
  assert.ok(text.includes('\n内容：&lt;!here&gt;\n&lt;https://evil.example|資料&gt;\n'));
  assert.equal(line(text, 'topic：'), 'topic：&lt;!subteam^S0000&gt;');
});

test('内容は改行を残し、1000文字をこえたら切る', () => {
  const multi = buildNewLeadMessage(contact({ body: '1行目\r\n2行目\r3行目' }));
  assert.ok(multi.text.endsWith('\n内容：1行目\n2行目\n3行目'));
  const long = buildNewLeadMessage(contact({ body: 'い'.repeat(1001) }));
  assert.ok(long.text.endsWith(`\n内容：${'い'.repeat(1000)}…`));
  const just = buildNewLeadMessage(contact({ body: 'う'.repeat(1000) }));
  assert.ok(just.text.endsWith(`\n内容：${'う'.repeat(1000)}`));
});

test('1行の欄は、改行や空白の続きを1つの空白にまとめ、200文字をこえたら切る（切ってから逃がす）', () => {
  const { text } = buildNewLeadMessage(
    contact({
      company: '架空商事\nページ：https://www.naus.co.jp/',
      name: 'あ'.repeat(201),
      topic: '&'.repeat(201),
    }),
  );
  assert.equal(line(text, '取引先：'), '取引先：架空商事 ページ：https://www.naus.co.jp/');
  assert.equal(line(text, 'ページ：'), undefined);
  assert.equal(line(text, '取引先責任者：'), `取引先責任者：${'あ'.repeat(200)}…さん`);
  assert.equal(line(text, 'topic：'), `topic：${'&amp;'.repeat(200)}…`);
});

test('空の欄は（未記入）。取引先責任者が空なら「さん」を付けない', () => {
  const { text } = buildNewLeadMessage(contact({ company: '   ', name: '', tel: '\n', body: ' \r\n ' }));
  assert.deepEqual(text.split('\n'), [
    '*新しい問い合わせ（会社のサイト）*',
    '取引先：（未記入）',
    '取引先責任者：（未記入）',
    'メール：（未記入）',
    '電話：（未記入）',
    '受付：2026/10/25 21:30',
    '内容：（未記入）',
  ]);
});

test('そのほかの項目は「項目名：値」で載せる。IP アドレス・ブラウザの種類・迷惑な送信のふるい分けの欄は載せない', () => {
  const { text } = buildNewLeadMessage(
    contact({
      'form-name': 'contact',
      'bot-field': '',
      topic: '求人紹介について（企業の方）',
      name: '架空 花子',
      agree: 'on',
      utm_source: 'newsletter',
      ip: '198.51.100.7',
      user_agent: 'Mozilla/5.0 (test)',
    }),
  );
  assert.deepEqual(text.split('\n').slice(7), ['topic：求人紹介について（企業の方）', 'agree：on', 'utm_source：newsletter']);
  assert.ok(!text.includes('198.51.100.7'));
  assert.ok(!text.includes('Mozilla'));
  assert.ok(!text.includes('bot-field'));
  assert.ok(!text.includes('form-name'));
});

test('送信したページは、このサイト（https://www.naus.co.jp/）のページのときだけ載せる', () => {
  const ours = buildNewLeadMessage(contact({ referrer: 'https://www.naus.co.jp/?utm_source=google' }));
  assert.equal(ours.text.split('\n').at(-1), 'ページ：https://www.naus.co.jp/?utm_source=google');
  for (const referrer of [
    'https://evil.example/',
    'https://www.naus.co.jp.evil.example/',
    'https://www.naus.co.jp@evil.example/',
    'http://www.naus.co.jp/',
    'https://ai.naus.co.jp/',
    'javascript:alert(1)',
    'not a url',
    '',
  ]) {
    const { text } = buildNewLeadMessage(contact({ referrer }));
    assert.equal(line(text, 'ページ：'), undefined, referrer);
  }
});

test('ページの URL に空白や改行を混ぜられても、このサイトの URL 1つとして載せ、別の行やリンクを作らせない', () => {
  const spaced = buildNewLeadMessage(contact({ referrer: 'https://www.naus.co.jp/ https://evil.example/' }));
  assert.equal(line(spaced.text, 'ページ：'), 'ページ：https://www.naus.co.jp/%20https://evil.example/');
  const broken = buildNewLeadMessage(contact({ email: 'taro@example.test', referrer: 'https://www.naus.co.jp/\nメール：x' }));
  assert.equal(broken.text.split('\n').filter((l) => l.startsWith('メール：')).length, 1);
  assert.match(line(broken.text, 'ページ：'), /^ページ：https:\/\/www\.naus\.co\.jp\/\S*$/);
});

test('form_name がなくても、送信の中身の form-name から見分ける', () => {
  const message = buildNewLeadMessage({ created_at: at, data: { 'form-name': 'contact', name: 'x' } });
  assert.equal(message.text.split('\n')[0], '*新しい問い合わせ（会社のサイト）*');
});

test('知らせないフォーム（名前のないもの・知らない名前）は null', () => {
  for (const formName of ['newsletter', 'constructor', '__proto__', 'toString', '']) {
    assert.equal(buildNewLeadMessage({ form_name: formName, created_at: at, data: { name: 'x' } }), null, formName);
  }
  assert.equal(buildNewLeadMessage({ created_at: at, data: { name: 'x' } }), null);
  assert.equal(buildNewLeadMessage(null), null);
  assert.equal(buildNewLeadMessage(undefined), null);
});

test('受付の日時が読めなければ、その行を出さない', () => {
  const { text } = buildNewLeadMessage({ form_name: 'contact', created_at: 'not-a-date', data: { name: 'x' } });
  assert.equal(line(text, '受付：'), undefined);
});

test('escapeSlack と formatJst', () => {
  assert.equal(escapeSlack('a<b>&c'), 'a&lt;b&gt;&amp;c');
  assert.equal(escapeSlack('&lt;'), '&amp;lt;');
  assert.equal(formatJst('2026-12-31T15:05:00Z'), '2027/01/01 00:05');
  assert.equal(formatJst('2026-10-25T00:00:00Z'), '2026/10/25 09:00');
  assert.equal(formatJst('x'), null);
  assert.equal(formatJst(undefined), null);
});
