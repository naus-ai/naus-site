// 受け口（functions/form-submit.mjs）の入口の守り：同じサイトからの送信だけ通す・連続送信を制限する。
// netlify/functions の中に置くと関数として公開されてしまうため、ここに置く

// 同じサイトのページからの送信だけを受け付ける（ブラウザはフォームの送信に Origin を付ける）
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

// 連続送信の簡易制限（同じ接続元から短時間に何度も送られたら断る）
// 実行環境ごとのメモリで数えるため、厳密な上限ではない（目安の歯止め）
const hits = new Map();
export function rateLimited(key, limit, windowMs, now = Date.now()) {
  if (!key) return false;
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > limit;
}
