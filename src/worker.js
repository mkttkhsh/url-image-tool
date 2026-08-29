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

  let title = '', images = [], source = '';
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
          source = 'shopify';
        }
      }
    }
    // 2) フォールバック: HTMLから og:image / JSON-LD / <img> を抽出
    if (images.length === 0) {
      const r = await fetch(target, { headers: { 'User-Agent': UA } });
      const html = await r.text();
      if (!title) {
        const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (t) title = decodeHtml(t[1].trim());
      }
      images = extractFromHtml(html, u);
      source = 'html';
    }
  } catch (e) {
    return json({ error: '取得に失敗しました: ' + String(e) }, 502);
  }

  images = dedup(images.map(s => absolutize(s, u)).filter(Boolean));
  return json({ title, images, count: images.length, source });
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
