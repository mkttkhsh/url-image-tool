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

  let title = '', images = [], videos = [], source = '', price = '', description = '', currency = '';
  try {
    // 1) Shopify: /products/<handle> → <handle>.json（画像）＋<handle>.js（動画含むmedia）
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
      // .js エンドポイントで media（動画含む）を追加取得
      try {
        const jsUrl = `${u.origin}/products/${m[1]}.js`;
        const rr = await fetch(jsUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (rr.ok) {
          const dd = await rr.json();
          for (const md of (dd.media || [])) {
            if (md.media_type === 'video' && Array.isArray(md.sources)) {
              // 最大サイズ/最高品質のmp4を選ぶ（無ければ先頭）
              const mp4s = md.sources.filter(s => (s.mime_type || '').includes('mp4') || /\.mp4/i.test(s.url || ''));
              const pick = mp4s.sort((a, b) => (b.width || 0) - (a.width || 0))[0] || md.sources[0];
              if (pick && pick.url) videos.push(pick.url);
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
    // 2) フォールバック: HTMLから og:image / JSON-LD / <img> ＋ 価格・通貨・説明・動画を抽出
    if (images.length === 0 || videos.length === 0 || !price || !description || !currency) {
      const r = await fetch(target, { headers: { 'User-Agent': UA } });
      const html = await r.text();
      if (!title) {
        const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (t) title = decodeHtml(t[1].trim());
      }
      if (images.length === 0) { images = extractFromHtml(html, u); source = source || 'html'; }
      if (videos.length === 0) { videos = extractVideosFromHtml(html); }
      const meta = extractMeta(html);
      if (!price) price = meta.price;
      if (!currency) currency = meta.currency;
      if (!description) description = meta.description;
    }
  } catch (e) {
    return json({ error: '取得に失敗しました: ' + String(e) }, 502);
  }

  images = dedup(images.map(s => absolutize(s, u)).filter(Boolean));
  videos = dedup(videos.map(s => absolutize(s, u)).filter(Boolean));
  const { priceJpy, priceText } = await toPriceText(price, currency);
  return json({ title, price, currency, priceJpy, priceText, description, images, videos, count: images.length, videoCount: videos.length, source });
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

// 掲載文（説明・PR・見出し）を Gemini または Claude で生成
async function handleGenerate(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST を使用してください' }, 405);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400); }
  const title = (b.title || '').toString().slice(0, 300);
  const price = (b.price || '').toString().slice(0, 60);
  const description = (b.description || '').toString().slice(0, 6000);
  const category = (['product','hotel','cafe','restaurant'].includes(b.category) ? b.category : 'product');
  const provider = (b.provider === 'claude') ? 'claude' : 'gemini';
  const tone = String(b.tone || '').slice(0, 40); // 標準 | ミニマル寄り | モード寄り | 詩的 | ストリート | クラシック
  const freeform = String(b.freeform || '').slice(0, 400); // ユーザーの自由指示（例：「もっと〇〇に」）
  const avoidWords = Array.isArray(b.avoidWords) ? b.avoidWords.slice(0, 80).map(w => String(w).slice(0, 20)) : [];
  const floor = String(b.floor || '').slice(0, 60); // 掲載フロア（TSV入力時）
  const itemName = String(b.itemName || '').slice(0, 60); // アイテム名（TSV入力時）
  if (!title && !description) return json({ error: '商品名か説明文が必要です' }, 400);

  const needsHeading = category !== 'product';
  const prompt = needsHeading
    ? buildPlacePrompt({ title, description, category, tone, freeform, avoidWords })
    : buildProductPrompt({ title, price, description, tone, freeform, avoidWords, floor, itemName });

  // provider 分岐
  try {
    let out;
    if (provider === 'claude') {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY が未設定です（wrangler secret put ANTHROPIC_API_KEY で登録）' }, 500);
      out = await callClaude(prompt, needsHeading, env);
    } else {
      if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY が未設定です' }, 500);
      out = await callGemini(prompt, needsHeading, env);
    }
    const result = { desc: (out.desc || '').trim(), pr: (out.pr || '').trim(), provider };
    if (needsHeading) result.heading = (out.heading || '').trim();
    // 公式仕様の運用にあわせ、末尾の「（〇〇文字）」は自動除去
    result.desc = result.desc.replace(/\s*[（(]\s*\d+\s*文字\s*[)）]\s*$/, '').trim();
    return json(result);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}

async function callGemini(prompt, needsHeading, env) {
  const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
  const schema = needsHeading
    ? { type: 'object', properties: { heading: { type: 'string' }, desc: { type: 'string' }, pr: { type: 'string' } }, required: ['heading', 'desc', 'pr'] }
    : { type: 'object', properties: { desc: { type: 'string' }, pr: { type: 'string' } }, required: ['desc', 'pr'] };
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json', responseSchema: schema },
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error('Gemini エラー: ' + t.slice(0, 240)); }
  const d = await r.json();
  return JSON.parse(d.candidates[0].content.parts[0].text);
}

async function callClaude(prompt, needsHeading, env) {
  const model = env.CLAUDE_MODEL || 'claude-3-5-sonnet-latest';
  const jsonInstruction = needsHeading
    ? '\n\n出力は次のJSONのみ。他のテキストや説明・コードフェンスは一切含めるな。\n{"heading":"…","pr":"…","desc":"…"}'
    : '\n\n出力は次のJSONのみ。他のテキストや説明・コードフェンスは一切含めるな。\n{"pr":"…","desc":"…"}';
  const body = {
    model, max_tokens: 1200, temperature: 0.7,
    system: '日本語のファッション/ライフスタイル編集者として、JSON形式のみで応答する。',
    messages: [{ role: 'user', content: prompt + jsonInstruction }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error('Claude エラー: ' + t.slice(0, 240)); }
  const d = await r.json();
  let text = (d.content && d.content[0] && d.content[0].text || '').trim();
  // コードフェンス除去
  const m = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (m) text = m[1].trim();
  return JSON.parse(text);
}

function toneClause(tone){
  if(!tone || tone==='標準') return '';
  return `\n# 表現の方向性\n- 「${tone}」で書く。他の方向は抑え、この方向性を明確に打ち出すこと。`;
}
function freeformClause(freeform){
  if(!freeform || !freeform.trim()) return '';
  return `\n# 追加指示（ユーザーから）\n${freeform.trim()}`;
}
function avoidClause(avoidWords){
  if(!avoidWords || !avoidWords.length) return '';
  return `\n# 今回避ける語彙（前の商品で既に使用済み。重複を避けよ）\n${avoidWords.join('、')}`;
}
function floorClause(floor){
  if(!floor) return '';
  // フロアからトーンヒント
  let hint = '';
  if(/LUXURY|HIGHFASHION/i.test(floor)) hint = '（重厚・格調・素材と職人性）';
  else if(/CONTEMPORARY|STREET/i.test(floor)) hint = '（機能・エッジ・都市的）';
  else if(/INTERIOR|DIGITAL/i.test(floor)) hint = '（生活文脈・実用・審美）';
  else if(/BEAUTY|BATH/i.test(floor)) hint = '（感性・香り・肌触り・生活の質）';
  else if(/KIDS/i.test(floor)) hint = '（親しみ・素材の安心感・遊び心）';
  else if(/TRAVEL/i.test(floor)) hint = '（体験価値・土地の物語・ロマン）';
  return `\n# 掲載フロア\n${floor} ${hint}`;
}

function buildProductPrompt({title, price, description, tone, freeform, avoidWords, floor, itemName}) {
  return `あなたはリステア創業者・高下ひろあき氏のように、感度の高いファッション・ライフスタイルウェブマガジンの編集者である。
以下の条件に基づき、商品の魅力を最大限に引き出す文章を2種類作成せよ。

# 入力データ
ブランド／商品名：${title || '(不明)'}
${itemName ? `アイテム名：${itemName}` : 'アイテム名：（商品名から判断）'}
商品スペック・説明テキスト：${description || '(取得できず)'}
参考価格：${price || '(不明)'}${floorClause(floor)}${toneClause(tone)}${freeformClause(freeform)}${avoidClause(avoidWords)}

# 出力ルール

① 説明文（である調・約200字）
- 文体は「である／だ」の断定調で統一（体言止め・名詞句止めも自然に混ぜてよい）。ですます調は使わない。
- 過度な修飾や詩的表現は避け、事実ベースで簡潔に。
- 情報の順序：素材・デザイン → ディテール・機能 → 製造背景・ブランド背景。
- 事実に基づく情報（素材、ディテール、機能、構造、使用シーン、ブランド背景）を明示。
- モデル名・コレクション名・特有の技術名は「」で囲む（例：「Rond Carré」「Dior Water Lily」）。
- 推測で断定しない。原文にない情報は書かない。公式説明が取れていない場合は商品名から確実に言える範囲に留める。
- 入力が英語の場合は原文に忠実に和訳し要点を整える。
- **文末に「（〇〇文字）」等の付加は不要**。本文のみ出力。
- トーンは洗練・明快・モード寄りを基本とする。

② PR文（40字以内）
- 一文で商品の印象・価値を端的に伝える。
- 語彙は簡潔かつ洗練。
- 「融合」「構造美」「宿す」「際立つ」「纏う」等の**価値語**を活かす（1つ以上含める）。
- 次のいずれかを必ず含める：素材の特徴／デザイン性／機能性／ブランドの世界観。
- 同一ブランド内で語彙・語尾の重複を避ける。
- 使用例：
  - 「グラデが際立つ機能派バックパック」
  - 「クライミング発想が光る、頼れる都市型バッグ」
  - 「パームと炎が交錯する光沢プリントTシャツ」
  - 「カーブロゴとモノグラムが際立つベースボールキャップ」

# 出力形式
JSONのみで出力する（他のテキスト・コードフェンスは含めない）:
{"pr": "<40字以内>", "desc": "<約200字・本文のみ>"}`;
}

# 出力例（200字仕様に拡張したイメージ）
{"pr": "編み込み風レザーにゴールドの立体クラスプが映えるクラッチ。", "desc": "編み込みエフェクトを施したゴートスキン製のテイクアウェイクラッチ「Rond Carré」。ゴールドトーンの持ち手にはスフィア（球体）とキューブ（立方体）のクラスプを配し、マグネット開閉で広げて中身を取り出せる構造に仕立てた。内側にカードポケットとコットンライニングを備え、ゴールドのロゴと金具が華やかさを添えるイタリア製の一品だ。（171文字）"}`;
}

function buildPlacePrompt({title, description, category, tone, freeform, avoidWords}) {
  const catJa = category === 'hotel' ? 'ホテル' : category === 'cafe' ? 'カフェ' : 'レストラン';
  const focus = category === 'hotel'
    ? '立地・建築や外観 → 客室・パブリックスペース → 料理・体験 → 訪れる価値'
    : category === 'cafe'
      ? '立地・雰囲気 → 内装・空間 → メニュー・過ごし方 → 訪れる価値'
      : '立地・店構え → シェフ／料理ジャンル → 名物メニュー・体験 → 訪れる価値';
  const headingHint = category === 'hotel'
    ? '例：「アルプスの山懐に抱かれた、静謐なるオーベルジュ」'
    : category === 'cafe'
      ? '例：「銀座の裏路地に佇む、大人のための和み珈琲店」'
      : '例：「京町家で味わう、ミシュラン一つ星の革新的フレンチ」';
  return `あなたはリステア創業者・高下ひろあき氏のように、感度の高い旅・ライフスタイル情報誌の編集者である。
以下の${catJa}情報から、掲載用テキストを3種類作成せよ。

# 入力データ
店名／施設名：${title || '(不明)'}
公式紹介文：${description || '(取得できず)'}${toneClause(tone)}${freeformClause(freeform)}${avoidClause(avoidWords)}

# 出力ルール

① 見出し（heading）— 40字以内
- ${catJa}の個性・立地・世界観を凝縮した一文（${headingHint}）
- 説明文の上に置く見出し。一覧用のPR文（pr）とは別の切り口・語彙で書く。

② 説明文（desc）— である調・約200字
- 文体「である／だ」を基本に、体言止め・名詞句止めも自然に混ぜる。ですます調は使わない。
- 過度な修飾・詩的表現・主観的絶賛（「唯一無二」「至高」等）を避け、事実で語る。
- 順序：${focus}、を3〜4文で。
- 推測で断定しない。原文にない情報は書かない。英語原文は忠実に和訳し要点を整える。
- **文末に「（〇〇文字）」等の付加は不要**。本文のみ。

③ PR文（pr）— 一覧用キャッチ・40字以内
- 一文で施設の魅力を端的に。見出しとは違う切り口で。
- 語彙は簡潔かつ洗練。同一ブランド内で語彙・語尾の重複を避ける。

# 出力形式
JSONのみで出力する（他のテキスト・コードフェンスは含めない）:
{"heading": "<40字以内>", "pr": "<40字以内>", "desc": "<約200字・本文のみ>"}`;
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
// HTMLから自ホスト動画URLを抽出（YouTube/Vimeo等の外部プレーヤーは対象外）
function extractVideosFromHtml(html) {
  const out = [];
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
  // <video src="..."> と <source src="..."> と data-src バリアント
  for (const m of html.matchAll(/<(?:video|source)[^>]*\b(?:src|data-src|data-video-src)=["']([^"']+)["']/gi)) {
    if (VIDEO_EXT.test(m[1])) out.push(m[1]);
  }
  // og:video / og:video:secure_url
  for (const m of html.matchAll(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/gi)) {
    if (VIDEO_EXT.test(m[1])) out.push(m[1]);
  }
  // JSON-LD の VideoObject.contentUrl
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectLdVideos(JSON.parse(m[1].trim()), out); } catch (e) { /* ignore */ }
  }
  return out;
}
function collectLdVideos(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectLdVideos(n, out)); return; }
  if (typeof node === 'object') {
    const t = node['@type'];
    if ((t === 'VideoObject' || (Array.isArray(t) && t.includes('VideoObject'))) && node.contentUrl) {
      out.push(String(node.contentUrl));
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') collectLdVideos(node[k], out);
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
