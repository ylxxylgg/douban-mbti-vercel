/**
 * Douban MBTI Bridge — Vercel Serverless API
 */
const https = require('https');

const MBTI_MAP = {
  INTJ:{name:'建筑师',desc:'富有想象力和战略性的思想家'},
  INTP:{name:'逻辑学家',desc:'创新思想家'},
  ENTJ:{name:'指挥官',desc:'大胆的领导者'},
  ENTP:{name:'辩论家',desc:'聪明好奇'},
  INFJ:{name:'提倡者',desc:'安静而神秘'},
  INFP:{name:'调停者',desc:'诗意善良的灵魂'},
  ENFJ:{name:'主人公',desc:'富有魅力和灵感'},
  ENFP:{name:'竞选者',desc:'热情洋溢'},
  ISTJ:{name:'物流师',desc:'务实且注重事实'},
  ISFJ:{name:'守护者',desc:'温暖而关心他人'},
  ESTJ:{name:'总经理',desc:'卓越执行者'},
  ESFJ:{name:'供给者',desc:'热情周到'},
  ISTP:{name:'鉴赏家',desc:'大胆而实用'},
  ISFP:{name:'探险家',desc:'灵活有魅力'},
  ESTP:{name:'企业家',desc:'精力充沛'},
  ESFP:{name:'表演者',desc:'自发性魅力热情'},
};

function extractUid(input) {
  const m = input.match(/(?:people|usr)\/([^\/\s?#]+)/);
  return m ? m[1] : input.trim();
}

function fetchHtml(targetUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function extractTitles(html) {
  const titles = new Set();
  const skip = new Set(['登录','注册','豆瓣','我的','收藏','看过','想读','在读','个人主页','书影音','展开','搜索','设置','通知']);
  const patterns = [
    /<a[^>]+class="[^"]*title[^"]*"[^>]*>([^<]{2,60})<\/a>/gi,
    /data-title="([^"]{2,60})"/gi,
    /alt="([^"]{2,60})"/gi,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(html)) !== null) {
      const t = m[1].trim().replace(/<[^>]+>/g, '');
      if (t.length < 2 || t.length > 80) continue;
      if (skip.has(t) || skip.has(t.slice(0, 2))) continue;
      if ([...t].filter(c => /[\u4e00-\u9fff]/.test(c)).length < 1) continue;
      titles.add(t);
    }
  }
  return [...titles];
}

async function scrapeWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchHtml(url);
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function scrapeMovies(uid) {
  const all = [];
  for (let p = 0; p < 3; p++) {
    try {
      const html = await scrapeWithRetry(
        `https://movie.douban.com/people/${uid}/collect?start=${p * 15}&sort=time&mode=grid`
      );
      all.push(...extractTitles(html));
      if (p < 2) await new Promise(r => setTimeout(r, 600));
    } catch (e) { /* skip failed page */ }
  }
  return [...new Set(all)].slice(0, 60);
}

async function scrapeBooks(uid) {
  try {
    const html = await scrapeWithRetry(
      `https://book.douban.com/people/${uid}/collect?start=0&sort=time&mode=grid`
    );
    return [...new Set(extractTitles(html))].slice(0, 30);
  } catch (e) {
    return [];
  }
}

function buildPrompt(data) {
  return `你是一个深度人格分析师，擅长从一个人的书影音偏好中解读其MBTI人格。

用户「${data.username}」的书影音偏好：

## 读书（${data.books.length}本）
${data.books.join('、') || '无数据'}

## 观影（${data.movies.length}部）
${data.movies.join('、') || '无数据'}

## 听歌（${data.music.length}张）
${data.music.join('、') || '无数据'}

请进行以下维度的深度分析，全部用中文输出：

【MBTI人格类型】：XYYY
【深度人格画像】（150字以内）
【认知风格解析】
【情感世界解读】
【审美偏好与自我表达】
【人际关系倾向】
【职业与事业驱动力】
【书影音品味评述】（3-4句，精准评价）`;
}

function parseResult(raw) {
  const typeMatch = raw.match(/\b(INFP|INFJ|INTP|INTJ|ISFP|ISFJ|ISTP|ISTJ|ENFP|ENFJ|ENTP|ENTJ|ESFP|ESFJ|ESTP|ESTJ)\b/i);
  const type = typeMatch ? typeMatch[1].toUpperCase() : '分析中';
  const lines = raw.split('\n');
  const para = (kws) => {
    for (const kw of kws) {
      const idx = lines.findIndex(l => l.includes(kw));
      if (idx !== -1) {
        return (lines[idx + 1] || '').replace(/^[【】:：\s—]+/, '').trim()
          || lines.slice(idx + 1, idx + 4).join(' ').replace(/^[【】:：\s—]+/, '').trim();
      }
    }
    return '';
  };
  return {
    type,
    portrait: para(['深度人格画像','人格画像']),
    cognitiveStyle: para(['认知风格']),
    emotionalWorld: para(['情感世界','内心世界']),
    aesthetics: para(['审美偏好','审美取向']),
    relationships: para(['人际关系','社交']),
    career: para(['职业','事业驱动力']),
    taste: para(['书影音品味','品味评述']),
  };
}

async function callMiniMax(prompt, apiKey) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 2500));
    try {
      const body = JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1800,
        temperature: 0.7
      });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.minimaxi.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
        }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('API timeout')); });
        req.write(body); req.end();
      });
      if (result.status === 429) continue;
      if (result.status !== 200) throw new Error(`MiniMax API ${result.status}`);
      const d = JSON.parse(result.body);
      return (d.choices?.[0]?.message?.content || '').trim();
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
  throw new Error('MiniMax 请求失败');
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { url, apiKey } = req.body || {};
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });
    if (!apiKey) return res.status(400).json({ error: '缺少 apiKey 参数' });

    const uid = extractUid(url);
    const [movies, books] = await Promise.all([
      scrapeMovies(uid),
      scrapeBooks(uid),
    ]);

    if (movies.length === 0 && books.length === 0) {
      return res.json({
        error: '无法抓取豆瓣数据，请确认用户 ID 正确且收藏为公开状态',
      });
    }

    const userData = { uid, username: uid, books, movies, music: [] };
    const prompt = buildPrompt(userData);
    const raw = await callMiniMax(prompt, apiKey);
    const result = parseResult(raw);

    res.json({
      ok: true,
      type: result.type,
      movies: movies.length,
      books: books.length,
      data: result,
    });
  } catch (e) {
    console.error('[Douban MBTI Error]', e.message);
    res.json({ error: e.message });
  }
};
