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

  let title = '', images = [], source = '', price = '', description = '';
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
        }
      }
    }
    // 2) フォールバック: HTMLから og:image / JSON-LD / <img> ＋ 価格・説明を抽出
    if (images.length === 0 || !price || !description) {
      const r = await fetch(target, { headers: { 'User-Agent': UA } });
      const html = await r.text();
      if (!title) {
        const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (t) title = decodeHtml(t[1].trim());
      }
      if (images.length === 0) { images = extractFromHtml(html, u); source = source || 'html'; }
      const meta = extractMeta(html);
      if (!price) price = meta.price;
      if (!description) description = meta.description;
    }
  } catch (e) {
    return json({ error: '取得に失敗しました: ' + String(e) }, 502);
  }

  images = dedup(images.map(s => absolutize(s, u)).filter(Boolean));
  return json({ title, price, description, images, count: images.length, source });
}

// HTMLから価格・説明の候補を拾う（JSON-LD offers.price / og:price / meta description）
function extractMeta(html) {
  let price = '', description = '';
  const ldPrice = [], ldDesc = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectLd(JSON.parse(m[1].trim()), ldPrice, ldDesc); } catch (e) { /* ignore */ }
  }
  const ogPrice = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
                 || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  price = ldPrice[0] || (ogPrice ? ogPrice[1] : '');
  description = stripHtml(ldDesc[0] || '') || (metaDesc ? decodeHtml(metaDesc[1]) : '');
  return { price, description };
}
function collectLd(node, prices, descs) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectLd(n, prices, descs)); return; }
  if (typeof node === 'object') {
    if (node.offers) {
      const off = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      if (off && off.price != null) prices.push(String(off.price));
    }
    if (node.price != null && node['@type'] && /Offer/i.test(node['@type'])) prices.push(String(node.price));
    if (typeof node.description === 'string' && node.description.trim()) descs.push(node.description);
    for (const k in node) if (node[k] && typeof node[k] === 'object') collectLd(node[k], prices, descs);
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
  return `あなたはセレクトショップのEC掲載文を書く日本語の編集者。以下の商品情報から掲載用テキストを作る。

商品名: ${title}
価格: ${price}
公式説明(原文): ${description || '(取得できず)'}

# 出力ルール
## 説明文（である調・約200字）
- 文末は「〜である／〜だ」で統一。過度な修飾や詩的表現を避け、事実ベースで簡潔に。
- 順序: 素材・デザイン → ディテール・機能 → 製造背景・ブランド背景。英語原文は忠実に和訳して要点を整える。
- 推測で断定しない。原文に無い情報は書かない。公式説明が取得できていない場合は、商品名から確実に言える範囲に留める。
## PR文（30字前後）
- 一文で商品の印象・価値を端的に表す。語彙は簡潔かつ洗練。
- 「融合」「構造美」「宿す」「際立つ」「纏う」等の価値語を活かし、素材の特徴／デザイン性／機能性／ブランドの世界観のいずれかを必ず含める。`;
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
