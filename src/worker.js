// URL画像取得＋背景拡張 正方形化ツール — Cloudflare Worker
// エンドポイント:
//   GET /api/scrape?url=<商品ページURL>  → { title, images:[...], count }
//   GET /api/img?src=<画像URL>           → 画像バイトをCORS付きで代理配信（Canvas汚染回避）
//   それ以外 → public/ の静的アセット（UI）

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/api/scrape') return handleScrape(url);
    if (url.pathname === '/api/img') return handleImg(url);
    if (url.pathname === '/api/generate') return handleGenerate(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
}

async function handleScrape(url) {
  const target = url.searchParams.get('url');
  if (!target) return json({ error: 'url パラメータが必要です' }, 400);
  let u;
  try { u = new URL(target); } catch (e) { return json({ error: 'URLが不正です' }, 400); }

  let title = '', images = [], source = '', price = '', description = '', currency = '';
  try {
    // 1) Shopify: /products/<handle> → <handle>.json（最も正確・高解像）
    const m = u.pathname.match(/\/products\/([^/?#]+)/);
    if (m) {
      const jsonUrl = `${u.origin}/products/${m[1]}.json`;
      const r = await fetch(jsonUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
        const d = await r.json();
        if (d && d.product) {
          title = d.product.title || '';
          images = (d.product.images || []).map(i => i.src).filter(Boolean);
          const v = (d.product.variants || [])[0] || {};
          price = v.price != null ? String(v.price) : '';
          description = stripHtml(d.product.body_html || '');
          source = 'shopify';
          try {
            const mr = await fetch(`${u.origin}/meta.json`, { headers: { 'User-Agent': UA } });
            if (mr.ok) { const md = await mr.json(); currency = md.currency || ''; }
          } catch (e) { /* ignore */ }
        }
      }
    }
    // 2) フォールバック: HTMLから og:image / JSON-LD / <img> ＋ 価格・通貨・説明を抽出
    if (images.length === 0 || !price || !description || !currency) {
      const r = await fetch(target, { headers: { 'User-Agent': UA } });
      const html = await r.text();
      if (!title) {
        const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (t) title = decodeHtml(t[1].trim());
      }
      if (images.length === 0) { images = extractFromHtml(html, u); source = source || 'html'; }
      const meta = extractMeta(html);
      if (!price) price = meta.price;
      if (!currency) currency = meta.currency;
      if (!description) description = meta.description;
    }
  } catch (e) {
    return json({ error: '取得に失敗しました: ' + String(e) }, 502);
  }

  images = dedup(images.map(s => absolutize(s, u)).filter(Boolean));
  const { priceJpy, priceText } = await toPriceText(price, currency);
  return json({ title, price, currency, priceJpy, priceText, description, images, count: images.length, source });
}

// 価格を日本円換算した表示文字列を作る
async function toPriceText(price, currency) {
  if (!price) return { priceJpy: null, priceText: '' };
  const num = parseFloat(String(price).replace(/[^0-9.]/g, ''));
  const cur = (currency || '').toUpperCase();
  if (isNaN(num)) return { priceJpy: null, priceText: String(price) + (cur ? ' ' + cur : '') };
  if (cur === 'JPY' || (!cur && /[¥￥]|円/.test(String(price)))) {
    return { priceJpy: Math.round(num), priceText: `¥${fmtNum(Math.round(num))}` };
  }
  if (cur) {
    const rate = await fxToJpy(cur);
    if (rate) {
      const jpy = Math.round(num * rate / 100) * 100; // 100円単位に丸め
      return { priceJpy: jpy, priceText: `約¥${fmtNum(jpy)}（${trimNum(num)} ${cur}）` };
    }
    return { priceJpy: null, priceText: `${trimNum(num)} ${cur}` };
  }
  return { priceJpy: null, priceText: trimNum(num) };
}
async function fxToJpy(cur) {
  if (cur === 'JPY') return 1;
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${cur}&symbols=JPY`);
    if (r.ok) { const d = await r.json(); if (d.rates && d.rates.JPY) return d.rates.JPY; }
  } catch (e) { /* ignore */ }
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${cur}`);
    if (r.ok) { const d = await r.json(); if (d.rates && d.rates.JPY) return d.rates.JPY; }
  } catch (e) { /* ignore */ }
  return null;
}
function fmtNum(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function trimNum(n) { return (Math.round(n * 100) / 100).toString(); }

// HTMLから価格・通貨・説明の候補を拾う（JSON-LD offers / og:price / meta description）
function extractMeta(html) {
  let price = '', description = '', currency = '';
  const ldPrice = [], ldDesc = [], ldCur = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectLd(JSON.parse(m[1].trim()), ldPrice, ldDesc, ldCur); } catch (e) { /* ignore */ }
  }
  const ogPrice = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  const ogCur = html.match(/<meta[^>]+property=["'](?:product:price:currency|og:price:currency)["'][^>]+content=["']([^"']+)["']/i);
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
                 || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  price = ldPrice[0] || (ogPrice ? ogPrice[1] : '');
  currency = ldCur[0] || (ogCur ? ogCur[1] : '');
  description = stripHtml(ldDesc[0] || '') || (metaDesc ? decodeHtml(metaDesc[1]) : '');
  return { price, currency, description };
}
function collectLd(node, prices, descs, curs) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectLd(n, prices, descs, curs)); return; }
  if (typeof node === 'object') {
    if (node.offers) {
      const off = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      if (off && off.price != null) prices.push(String(off.price));
      if (off && off.priceCurrency) curs.push(String(off.priceCurrency));
    }
    if (node.price != null && node['@type'] && /Offer/i.test(node['@type'])) prices.push(String(node.price));
    if (node.priceCurrency) curs.push(String(node.priceCurrency));
    if (typeof node.description === 'string' && node.description.trim()) descs.push(node.description);
    for (const k in node) if (node[k] && typeof node[k] === 'object') collectLd(node[k], prices, descs, curs);
  }
}
function stripHtml(s) {
  return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// である調説明文＋PR文を Gemini で生成
async function handleGenerate(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST を使用してください' }, 405);
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY が未設定です（wrangler secret put で登録してください）' }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400); }
  const title = (b.title || '').toString().slice(0, 300);
  const price = (b.price || '').toString().slice(0, 60);
  const description = (b.description || '').toString().slice(0, 4000);
  if (!title && !description) return json({ error: '商品名か説明文が必要です' }, 400);

  const prompt = buildPrompt(title, price, description);
  const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { desc: { type: 'string' }, pr: { type: 'string' } }, required: ['desc', 'pr'] },
    },
  };
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { return json({ error: 'Gemini 接続失敗: ' + String(e) }, 502); }
  if (!r.ok) { const t = await r.text(); return json({ error: 'Gemini エラー: ' + t.slice(0, 240) }, 502); }
  const d = await r.json();
  let out;
  try { out = JSON.parse(d.candidates[0].content.parts[0].text); }
  catch (e) { return json({ error: '生成結果の解析に失敗しました' }, 502); }
  return json({ desc: (out.desc || '').trim(), pr: (out.pr || '').trim() });
}

function buildPrompt(title, price, description) {
  return `# 目的
与えられた「商品情報」をもとに、セレクトショップ「246（246select.com）」の掲載用テキストを作成する。
出力は「一覧ページ用キャッチコピー」と「詳細ページ用説明文」の2種類。

# 役割・トーン＆マナー
- 高級感と洗練された印象を与えるファッション・ライフスタイル系ECのコピーライターとして執筆する。
- 語尾・文体：「〜だ。」「〜である。」の断定調に加え、**体言止め・名詞句止め**（例：「〜デザイン。」「〜使用。」「〜イタリア製。」）も自然に織り交ぜる。ですます調は使わない。
- 事実に基づく具体的な特徴（素材、構造、ディテール、サイズ感、原産国、モデル名）を端的に伝える。詩的表現・過度な形容詞・主観的な絶賛（「唯一無二」「至高」等）は避ける。
- モデル名・コレクション名・特有の技術名は「」で囲む（例：「Rond Carré」「Dior Water Lily」）。
- 推測で断定しない。原文にない情報は書かない。公式説明が取得できていない場合は、商品名から確実に言える範囲に留める。英語原文は忠実に和訳し要点を整える。

# 入力データ
ブランド名 / 商品名：${title || '(不明)'}
アイテムカテゴリ：（商品名・説明文から判断すること）
商品スペック・説明テキスト：${description || '(取得できず)'}
参考価格：${price || '(不明)'}

# 出力フォーマット・ルール

1. 【一覧ページ用キャッチコピー】（JSONキー: pr）
- 文字数：20文字〜30文字程度（厳守）
- ブランド名／商品名の最も特徴的なディテール（素材・柄・フォルム・カラー等）を凝縮した一文。
- 文字数の括弧書きは付けない。本文のみを出力する。

2. 【詳細ページ用説明文】（JSONキー: desc）
- 文字数：**200文字程度（目安180〜220字）**。
- 構成：素材／モデル名 → 主要ディテール（金具・柄・ストラップ等） → 機能・使用シーン → 製造国／ブランド背景、の順で3〜4文に収める。
- 文末に「（〇〇文字）」と正確な文字数を必ず記載する（本文の文字数のみカウント、括弧書き自体はカウント外）。
- 誇張せず、246select.com の実掲載文と同じ落ち着いたトーンで書く。

# 出力形式
以下のJSONで出力する:
{"pr": "<キャッチコピー本文20〜30字>", "desc": "<説明文180〜220字>（〇〇文字）"}

# 246select.com の実掲載文サンプル（このトーンに揃える）
- JACQUEMUS クラッチ：「編み込みエフェクトを施したゴートスキン製のテイクアウェイクラッチ「Rond Carré」。ゴールドトーンの持ち手にはスフィア（球体）とキューブ（立方体）のクラスプを配した。マグネット開閉で、内側にカードポケットとコットンライニングを備える。イタリア製。」
- RIMOWA クロスボディバッグ：「イタリア製のGroove（グルーヴ）- レザー クロスボディバッグ オレンジ スモールは、しなやかで滑らかなカーフレザーを使用。洗練された佇まいで、現代のライフスタイルに寄り添うデザイン。」
- DIOR トートバッグ：「「Dior Water Lily」モチーフを全面に刺繍した「ディオール ブックトート」スモールサイズ。コレクションショーが披露されたチュイルリー公園へのオマージュとして睡蓮を描き、18世紀ロココ様式に着想を得たDior Médaillonシグネチャーをフロントにあしらった。トップハンドルに加え、調節・取り外し可能なショルダーストラップを備え、ハンドバッグやショルダー、クロスボディとして使える実用的なデザイン。」

# 出力例（200字仕様に拡張したイメージ）
{"pr": "編み込み風レザーにゴールドの立体クラスプが映えるクラッチ。", "desc": "編み込みエフェクトを施したゴートスキン製のテイクアウェイクラッチ「Rond Carré」。ゴールドトーンの持ち手にはスフィア（球体）とキューブ（立方体）のクラスプを配し、マグネット開閉で広げて中身を取り出せる構造に仕立てた。内側にカードポケットとコットンライニングを備え、ゴールドのロゴと金具が華やかさを添えるイタリア製の一品だ。（171文字）"}`;
}

function extractFromHtml(html, u) {
  const out = [];
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectLdImages(JSON.parse(m[1].trim()), out); } catch (e) { /* ignore */ }
  }
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\b(?:data-src|data-original|src)=["']([^"']+)["']/i) || [])[1];
    if (src && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(src)) out.push(src);
    const srcset = (tag.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    if (srcset) {
      const largest = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
      if (largest) out.push(largest);
    }
  }
  return out;
}
function collectLdImages(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectLdImages(n, out)); return; }
  if (typeof node === 'object') {
    if (node.image) {
      if (typeof node.image === 'string') out.push(node.image);
      else if (Array.isArray(node.image)) node.image.forEach(i => out.push(typeof i === 'string' ? i : i && i.url));
      else if (node.image.url) out.push(node.image.url);
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') collectLdImages(node[k], out);
  }
}
function absolutize(s, u) { try { return new URL(s, u).href; } catch (e) { return null; } }
function dedup(a) { return [...new Set(a)]; }
function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'");
}

async function handleImg(url) {
  const src = url.searchParams.get('src');
  if (!src) return new Response('src required', { status: 400 });
  let r;
  try { r = await fetch(src, { headers: { 'User-Agent': UA } }); }
  catch (e) { return new Response('fetch failed', { status: 502 }); }
  const h = new Headers();
  h.set('content-type', r.headers.get('content-type') || 'application/octet-stream');
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Cache-Control', 'public, max-age=3600');
  return new Response(r.body, { status: r.status, headers: h });
}
