# URL取得＋正方形化ツール（Cloudflare Worker）

商品ページのURLを入れると写真を取得し、**背景を端の色で拡張して継ぎ目なく正方形化**してダウンロードできるツール。
1つのCloudflare Workerが「UI・スクレイプAPI・画像プロキシ」を全部ホストします。

## 仕組み
- `GET /api/scrape?url=<商品URL>` … 画像・価格・説明文を取得。Shopifyは `<handle>.json`、それ以外は og:image / JSON-LD / meta / `<img>` から抽出
- `GET /api/img?src=<画像URL>` … 画像を代理配信（CORS付き）。ブラウザのCanvas汚染を回避し、加工・DLを可能にする
- `POST /api/generate` … `{title, price, description}` から Gemini で「である調説明文（約200字）＋PR文（30字前後）」を生成して返す
- `/` … UI（`public/index.html`）。正方形化はブラウザ内（Canvas）で処理

## テキスト生成のセットアップ（Gemini）
`/api/generate` は Google の Gemini API を使います。APIキーは Worker のシークレットに登録（リポジトリには入れません）:
```bash
printf '%s' "<your GEMINI_API_KEY>" | npx wrangler secret put GEMINI_API_KEY
```
モデルは既定 `gemini-3.6-flash`。変えたい場合は `wrangler.toml` の `[vars]` に `GEMINI_MODEL` を設定。
※ `/api/generate` は公開エンドポイントなので、不特定多数に使わせたくない場合は簡易パスフレーズ等の保護を追加してください。

## ローカル実行
```bash
npm install
npm run dev        # http://localhost:8787
```

## デプロイ
```bash
npx wrangler login   # 初回のみ（ブラウザでCloudflareにログイン）
npm run deploy       # https://url-image-tool.<subdomain>.workers.dev/
```

## 制限
- JavaScriptで動的に画像を描画する重いサイト（一部の高級ブランド）は取得できないことがあります。
  その場合は元のローカルPythonスキル（Playwright対応）を使ってください。

セレクトショップ246の掲載作業用に作成。
