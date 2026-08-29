# URL取得＋正方形化ツール（Cloudflare Worker）

商品ページのURLを入れると写真を取得し、**背景を端の色で拡張して継ぎ目なく正方形化**してダウンロードできるツール。
1つのCloudflare Workerが「UI・スクレイプAPI・画像プロキシ」を全部ホストします。

## 仕組み
- `GET /api/scrape?url=<商品URL>` … Shopifyストアは `<handle>.json` から画像を取得。それ以外は og:image / JSON-LD / `<img>` から抽出
- `GET /api/img?src=<画像URL>` … 画像を代理配信（CORS付き）。ブラウザのCanvas汚染を回避し、加工・DLを可能にする
- `/` … UI（`public/index.html`）。正方形化はブラウザ内（Canvas）で処理

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
