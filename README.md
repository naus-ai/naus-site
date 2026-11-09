# naus-site

株式会社naus の会社のサイト（静的な HTML）。Netlify で公開する。

## フォームの送信を Slack に知らせる
- `netlify/functions/submission-created.mjs`：お問い合わせのフォーム（`contact`）が送信されたら、Slack の `#new-leads` に、フォームの項目すべて（取引先・取引先責任者・メール・電話・内容と、お問い合わせの種類などのそのほかの項目）・受け付けた日時・送信したページ（このサイト `https://www.naus.co.jp/` のページのときだけ）を知らせる。IP アドレスとブラウザの種類は載せない
- Netlify が送信を確かめたあと、Netlify 自身の署名付きの合図でだけ動く（外からは呼べない）。Slack に送れなくても、フォームの送信は受け付け済み
- 送信は、まず CRM の受付窓口（`netlify/notify/intake.mjs`。見出し `X-Naus-Sender: site`・署名付き、4秒で諦める）に送る。届いたら Slack には送らない（CRM が知らせる）。届かなかったときだけ、先頭に「⚠ CRM に送れなかったため、会社のサイトから直接知らせています」を付けて Slack に直接知らせる（4秒で諦める）
- フォームの流入元（utm など7項目の隠し項目）は `assets/source-fields.js` が、このブラウザの `naus_source_site` に30日覚えて埋める
- 送り先の鍵は Netlify の環境変数（秘密）。`INTAKE_URL`・`INTAKE_KEY`（CRM の受付窓口）と `SLACK_WEBHOOK_URL`（Slack の Incoming Webhook の URL）。コードには置かない
- テスト：`node --test netlify/notify/*.test.mjs`。テストのファイルは `netlify/functions` に置かない（置くと、外から呼べる処理として公開されるため）
