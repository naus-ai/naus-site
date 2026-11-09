// 流入元の記録（assets/source-fields.js）のテスト。ブラウザ用のファイルを node:vm でそのまま動かす。
// location・document・localStorage は、このファイルの中の最小の偽物。データはすべて架空
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE_JS = readFileSync(new URL('../../assets/source-fields.js', import.meta.url), 'utf8');
const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

const FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'landing_page', 'referrer_host'];
const SITE = 'https://www.naus.co.jp';
const KEY = 'naus_source_site';

// 保存領域の偽物。broken を true にすると、読み書きが投げる（プライベートのタブ・アプリの中のブラウザ）
function fakeStorage(init = {}, broken = false) {
  const data = { ...init };
  return {
    data,
    getItem(k) { if (broken) throw new Error('denied'); return k in data ? data[k] : null; },
    setItem(k, v) { if (broken) throw new Error('denied'); data[k] = String(v); },
    removeItem(k) { if (broken) throw new Error('denied'); delete data[k]; },
  };
}

// contact フォームだけを持つ偽の document。隠し項目は7つ（無関係なフォーム other も置いて、触らないことを確かめる）
function fakeDocument(referrer) {
  const forms = {};
  for (const name of ['contact', 'other']) {
    const inputs = {};
    for (const f of FIELDS) inputs[f] = { value: '' };
    forms[name] = { inputs, elements: { namedItem: (n) => inputs[n] || null } };
  }
  const listeners = {};
  return {
    forms,
    referrer: referrer || '',
    querySelector(sel) {
      const m = /^form\[name="(.+)"\]$/.exec(sel);
      return m ? forms[m[1]] || null : null;
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type) { if (listeners[type]) listeners[type](); },
  };
}

// ページを1回開く（source-fields.js を読み込む）。同じ storage を渡せば、ブラウザを続けて使ったことになる
function visit(url, { storage = fakeStorage(), referrer = '', now = Date.now() } = {}) {
  const u = new URL(url, SITE);
  const document = fakeDocument(referrer);
  const winListeners = {};
  const window = { addEventListener(type, fn) { winListeners[type] = fn; } };
  const RealDate = Date;
  const fakeDate = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  };
  const ctx = vm.createContext({
    window,
    document,
    localStorage: storage,
    location: { search: u.search, pathname: u.pathname, host: u.host },
    URL,
    URLSearchParams,
    JSON,
    Date: fakeDate,
  });
  vm.runInContext(SOURCE_JS, ctx);
  return { storage, document, window, winListeners, ctx };
}

const record = (storage) => JSON.parse(storage.data[KEY]);
const valuesOf = (form) => Object.fromEntries(FIELDS.map((f) => [f, form.inputs[f].value]));

test('保存先は naus_source_site だけ。utm があれば覚え、contact フォームの7項目に入る', () => {
  const v = visit('/?utm_source=note&utm_medium=article&utm_campaign=spring&utm_content=a&utm_term=ai');
  assert.deepEqual(Object.keys(v.storage.data), [KEY]);
  assert.deepEqual(valuesOf(v.document.forms.contact), {
    utm_source: 'note', utm_medium: 'article', utm_campaign: 'spring', utm_content: 'a', utm_term: 'ai',
    landing_page: '/', referrer_host: '',
  });
  assert.deepEqual(Object.keys(record(v.storage).d).sort(), [...FIELDS].sort());
});

test('contact 以外のフォームには触らない', () => {
  const v = visit('/?utm_source=note');
  assert.equal(valuesOf(v.document.forms.other).utm_source, '');
});

test('記号（?c=）は扱わない。doc_code は覚えず、フォームにも入れない', () => {
  const v = visit('/?utm_source=note&c=C0012');
  assert.ok(!('doc_code' in record(v.storage).d));
  assert.ok(!INDEX_HTML.includes('name="doc_code"'));
});

test('外部サイトから来たとき（目印なし）は、来訪を保存する。参照元はホスト名だけ', () => {
  const v = visit('/', { referrer: 'https://news.example.test/a?x=1' });
  const f = valuesOf(v.document.forms.contact);
  assert.equal(f.referrer_host, 'news.example.test');
  assert.equal(f.landing_page, '/');
  assert.equal(f.utm_source, '');
});

test('同じサイト内の移動で、記録がなければ、何も作らない', () => {
  const v = visit('/', { referrer: SITE + '/privacy.html' });
  assert.deepEqual(v.storage.data, {});
  assert.equal(valuesOf(v.document.forms.contact).landing_page, '');
});

test('utm が新しくなれば上書き。utm なしの訪問では変えない（期限も延ばさない）', () => {
  const storage = fakeStorage();
  const t0 = 1_800_000_000_000;
  visit('/?utm_source=a', { storage, now: t0 });
  visit('/', { storage, now: t0 + 86400000 });
  assert.equal(record(storage).t, t0);
  assert.equal(record(storage).d.utm_source, 'a');
  visit('/?utm_source=b', { storage, now: t0 + 2 * 86400000 });
  assert.equal(record(storage).d.utm_source, 'b');
  assert.equal(record(storage).t, t0 + 2 * 86400000);
});

test('30日を過ぎた記録は破棄する。30日以内なら残る', () => {
  const now = Date.now();
  const old = fakeStorage({ [KEY]: JSON.stringify({ t: now - 31 * 86400000, d: { utm_source: 'old' } }) });
  const v = visit('/', { storage: old, now });
  assert.equal(valuesOf(v.document.forms.contact).utm_source, '');
  const fresh = fakeStorage({ [KEY]: JSON.stringify({ t: now - 29 * 86400000, d: { utm_source: 'keep' } }) });
  const v2 = visit('/', { storage: fresh, now });
  assert.equal(valuesOf(v2.document.forms.contact).utm_source, 'keep');
});

test('古い naus_source は読まない（空で送る）', () => {
  const storage = fakeStorage({ naus_source: JSON.stringify({ t: Date.now(), d: { utm_source: 'old', landing_page: '/old/' } }) });
  const v = visit('/', { storage, referrer: SITE + '/' });
  assert.equal(valuesOf(v.document.forms.contact).utm_source, '');
  assert.deepEqual(Object.keys(storage.data), ['naus_source']);
});

test('localStorage が使えなくても、投げずに動く（何も埋めずに送れる）', () => {
  const v = visit('/?utm_source=note', { storage: fakeStorage({}, true) });
  assert.deepEqual(valuesOf(v.document.forms.contact), Object.fromEntries(FIELDS.map((f) => [f, ''])));
});

test('送信の直前と pageshow で、もう一度埋める', () => {
  const v = visit('/?utm_source=note');
  v.document.forms.contact.inputs.utm_source.value = '';
  v.document.fire('submit');
  assert.equal(v.document.forms.contact.inputs.utm_source.value, 'note');
  v.document.forms.contact.inputs.utm_source.value = '';
  v.winListeners.pageshow();
  assert.equal(v.document.forms.contact.inputs.utm_source.value, 'note');
});

test('index.html：contact フォームに隠し項目が7つ（空）あり、ページの最後で source-fields.js を読む', () => {
  const form = INDEX_HTML.match(/<form[^>]*name="contact"[\s\S]*?<\/form>/)[0];
  for (const f of FIELDS) assert.ok(form.includes(`<input type="hidden" name="${f}" value="">`), f);
  const tag = '<script src="/assets/source-fields.js"></script>';
  assert.ok(INDEX_HTML.includes(tag));
  assert.ok(INDEX_HTML.indexOf(tag) > INDEX_HTML.indexOf('</form>'));
  assert.ok(INDEX_HTML.indexOf(tag) < INDEX_HTML.indexOf('</body>'));
});
