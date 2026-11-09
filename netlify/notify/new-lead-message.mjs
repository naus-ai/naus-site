// お問い合わせのフォームの送信を Slack に知らせる文を作る。
// 載せるのは、フォームで受け取った項目すべて（取引先・取引先責任者・メール・電話・内容と、そのほかの項目）、受け付けた日時、
// 送信したページ（このサイトのページのときだけ）。IP アドレスとブラウザの種類は載せない（対応には使わない個人の手がかりのため）

// どのフォームか（form-name）→ 見出しと、各行に使う欄の名前（index.html のフォームの name に合わせる）
const FORMS = {
  contact: {
    title: '新しい問い合わせ（会社のサイト）',
    company: 'company',
    name: 'name',
    email: 'email',
    phone: 'tel',
    message: 'body',
  },
};

const MAX_FIELD = 200;
const MAX_MESSAGE = 1000;
const EMPTY = '（未記入）';
// 受付窓口（CRM）に送れなかったときの予備の知らせの印（先頭の行）
const FALLBACK_NOTE = '⚠ CRM に送れなかったため、会社のサイトから直接知らせています';
// このサイトの住所。送信したページは、ここのページのときだけ載せる
const SITE_ORIGIN = 'https://www.naus.co.jp';
// 「そのほかの項目」に出さないもの（迷惑な送信のふるい分けの欄と、Netlify が足す項目）
const HIDDEN = ['form-name', 'bot-field', 'ip', 'user_agent', 'referrer'];

// Slack の書き方で意味を持つ文字を逃がす（名前などに <!channel> や <https://…|…> を入れられても、メンションやリンクにしない）
export function escapeSlack(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 1行の欄（改行や空白の続きは1つの空白にまとめる）
function line(data, key) {
  const value = typeof data[key] === 'string' ? data[key].replace(/\s+/g, ' ').trim() : '';
  return value ? escapeSlack(clip(value, MAX_FIELD)) : EMPTY;
}

// 内容（改行は残す）
function body(data, key) {
  const value = typeof data[key] === 'string' ? data[key].replace(/\r\n?/g, '\n').trim() : '';
  return value ? escapeSlack(clip(value, MAX_MESSAGE)) : EMPTY;
}

// 送信したページ。このサイトのページのときだけ、URL を1つの形に整えて返す（それ以外は null）。
// 送信元のページは送る側が自由に書けるため、空白や改行を混ぜられても、ほかのリンクや行を作らせない
function page(data) {
  if (typeof data.referrer !== 'string') return null;
  let url;
  try {
    url = new URL(data.referrer);
  } catch {
    return null;
  }
  return url.origin === SITE_ORIGIN ? escapeSlack(clip(url.href, MAX_FIELD)) : null;
}

// 受け付けた日時を日本時間の「2026/10/25 21:30」にする（読めないときは null）
export function formatJst(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

// Netlify の送信の中身（payload）から、Slack に送る文を作る。知らせないフォームなら null
// fallback: true のときは、先頭に予備の知らせの印を付ける
export function buildNewLeadMessage(payload, { fallback = false } = {}) {
  const formName = payload?.form_name ?? payload?.data?.['form-name'];
  const form = Object.hasOwn(FORMS, formName) ? FORMS[formName] : null;
  if (!form) return null;
  const data = payload.data ?? {};
  const name = line(data, form.name);
  const lines = [
    ...(fallback ? [FALLBACK_NOTE] : []),
    `*${form.title}*`,
    `取引先：${line(data, form.company)}`,
    `取引先責任者：${name === EMPTY ? EMPTY : `${name}さん`}`,
    `メール：${line(data, form.email)}`,
    `電話：${line(data, form.phone)}`,
  ];
  const at = formatJst(payload.created_at);
  if (at) lines.push(`受付：${at}`);
  lines.push(`内容：${body(data, form.message)}`);
  // そのほかの項目（お問い合わせの種類など。あとでフォームに足した項目も、ここに出る）
  const shown = new Set([...HIDDEN, form.company, form.name, form.email, form.phone, form.message]);
  for (const key of Object.keys(data)) {
    if (shown.has(key) || typeof data[key] !== 'string') continue;
    lines.push(`${escapeSlack(clip(key, 50))}：${line(data, key)}`);
  }
  const url = page(data);
  if (url) lines.push(`ページ：${url}`);
  // リンクの下見（プレビュー）は出さない
  return { text: lines.join('\n'), unfurl_links: false, unfurl_media: false };
}
