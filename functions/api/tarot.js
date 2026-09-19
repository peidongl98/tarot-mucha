/* functions/api/tarot.js — Cloudflare Pages Function
 * 路由：POST /api/tarot
 *
 * 入参：{ question: string, cards: [{ name, position, reversed, en?, meaning?, keywords? }] }
 * 出参：{ success: boolean, reading?: string, error?: string }
 *
 * 模型：glm-4.7-flash（智谱）
 * Key ：只从环境变量 GLM_API_KEY 读取，绝不写入代码或返回给前端
 *
 * 关于 thinking：glm-4.7-flash 默认是推理型模型，实测一次解读会先产出约 800–1000 个
 * reasoning token 才轮到正文，容易把 max_tokens 吃光导致正文为空（finish_reason=length）。
 * 因此这里显式关闭思考链：正文完整、耗时从 ~13s 降到 ~4.5s，稳稳落在 30s 预算内。
 */

const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/* 主模型：按需求指定 */
const GLM_MODEL = 'glm-4.7-flash';

/* 备用模型：glm-4.7-flash 在高峰期会整段时间不可用（实测连续 6 次全部返回
 * 429 / code 1305「该模型当前访问量过大」），此时自动降级到 glm-4.6 保证功能可用。
 * 设为 null 则只用主模型（接受高峰期报错）。 */
const GLM_FALLBACK_MODEL = 'glm-4.6';

/* 总预算 30s；留 2s 余量给 Cloudflare 侧收尾 */
const TOTAL_BUDGET_MS = 28000;
const MAX_QUESTION_LEN = 200;
const MAX_TOKENS = 1200;

/* 单个模型内的重试退避 */
const RETRY_DELAYS = [900, 1800];

const SYSTEM_PROMPT = `你是「穆夏塔罗」的塔罗解读师，沉稳、优雅、静谧。

语气与风格：
- 像一位在安静房间里为你翻牌的解读者，语速缓慢，用词克制
- 有洞察力，能指出三张牌之间的张力与呼应
- 略带神秘感，但绝不装神弄鬼、不故弄玄虚、不使用夸张的宿命论措辞
- 不科普塔罗历史与体系，不说教，不评判提问者的处境
- 不要提及自己是 AI、模型或程序

写作要求：
- 使用简体中文
- 结合提问者的具体问题 + 三张牌（过去 / 现在 / 未来）+ 各自的正位或逆位
- 三张牌之间要有内在的逻辑推进，不要三段各说各话
- 总长度 220–380 字（含结尾语）
- 必须分成 2–3 段，段与段之间用换行分隔，不要把全部内容挤成一段
- 只写自然段落，不要使用 Markdown 标题、列表、加粗等符号
- 最后单独起一行写：以上解读仅供娱乐参考`;

/* ============================================================
 * 工具
 * ============================================================ */

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, extra),
  });
}

function asText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/* 把三张牌整理成模型好读的文本 */
function formatCards(cards) {
  return cards.map((c, i) => {
    const pos = asText(c.position, 8) || ['过去', '现在', '未来'][i];
    const name = asText(c.name, 24);
    const en = asText(c.en, 40);
    const orient = c.reversed ? '逆位' : '正位';
    const lines = [`${i + 1}. ${pos}：${name}${en ? `（${en}）` : ''}｜${orient}`];
    const meaning = asText(c.meaning, 300);
    if (meaning) lines.push(`   牌义参考：${meaning}`);
    if (Array.isArray(c.keywords) && c.keywords.length) {
      const kw = c.keywords.map((k) => asText(k, 12)).filter(Boolean).slice(0, 6);
      if (kw.length) lines.push(`   关键词：${kw.join('、')}`);
    }
    return lines.join('\n');
  }).join('\n');
}

function buildUserMessage(question, cards) {
  const q = question
    ? `提问：${question}`
    : '提问：（提问者没有写下具体问题，请给出一段整体性的解读，落到可感知的方向上）';
  return `${q}

牌阵（过去 - 现在 - 未来）：
${formatCards(cards)}

请按上述要求写出解读。`;
}

/* 校验入参 */
function validate(body) {
  if (!body || typeof body !== 'object') return '请求内容无法解析。';
  const cards = body.cards;
  if (!Array.isArray(cards) || cards.length !== 3) return '牌阵信息不完整，请重新抽牌后再试。';
  for (const c of cards) {
    if (!c || typeof c !== 'object') return '牌阵信息有误。';
    if (!asText(c.name, 24)) return '牌面名称缺失，请重新抽牌。';
  }
  if (body.question != null && typeof body.question !== 'string') return '提问格式有误。';
  return null;
}

/* ============================================================
 * 调 GLM
 * ============================================================ */

async function callGlm(key, messages, timeoutMs, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));

  try {
    const res = await fetch(GLM_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || GLM_MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.85,
        stream: false,
        thinking: { type: 'disabled' },   // 关键：关掉推理链，保证正文完整且够快
      }),
      signal: ctrl.signal,
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }

    if (!res.ok) {
      const code = data && data.error && data.error.code;
      return { ok: false, status: res.status, code, raw };
    }
    if (!data) return { ok: false, status: res.status, code: 'bad-json', raw };

    const choice = (data.choices && data.choices[0]) || null;
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content.trim() : '';

    return { ok: true, content, finish: choice && choice.finish_reason };
  } catch (e) {
    return { ok: false, status: 0, code: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const isOverloaded = (r) => !!r && (r.status === 429 || String(r.code) === '1305');

/* 主模型 → 备用模型依次尝试，每个模型内部退避重试；始终不越过总预算 */
async function callWithFailover(key, messages, started) {
  const models = [GLM_MODEL];
  if (GLM_FALLBACK_MODEL && GLM_FALLBACK_MODEL !== GLM_MODEL) models.push(GLM_FALLBACK_MODEL);

  let last = null;
  let usedModel = models[0];

  for (const model of models) {
    let attempt = 0;
    for (;;) {
      const remain = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remain < 6000) return { result: last, usedModel };

      const r = await callGlm(key, messages, remain, model);
      last = r;
      usedModel = model;
      if (r.ok) return { result: r, usedModel };
      if (!isOverloaded(r) || attempt >= RETRY_DELAYS.length) break;

      const delay = RETRY_DELAYS[attempt++];
      if (Date.now() - started + delay > TOTAL_BUDGET_MS - 6000) break;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  return { result: last, usedModel };
}

/* ============================================================
 * 路由
 * ============================================================ */

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, error: '请求内容无法解析。' }, 400);
  }

  const bad = validate(body);
  if (bad) return json({ success: false, error: bad }, 400);

  const key = env && env.GLM_API_KEY;
  if (!key) {
    // 不暴露任何变量名之外的信息
    return json({
      success: false,
      error: '解读服务尚未配置完成，请稍后再试。',
    }, 503);
  }

  const question = asText(body.question, MAX_QUESTION_LEN);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(question, body.cards) },
  ];

  const started = Date.now();

  const first = await callWithFailover(key, messages, started);
  const result = first.result;
  const lastOverloaded = isOverloaded(result);

  if (!result || !result.ok) {
    if (result && result.code === 'timeout') {
      return json({ success: false, error: '解读超时了，模型正忙。请稍后再试一次。' }, 504);
    }
    if (lastOverloaded) {
      return json({ success: false, error: '此刻求问的人有点多，解读师正在稍作停顿。请过一会儿再试。' }, 503);
    }
    return json({ success: false, error: '解读服务暂时不可用，请稍后再试。' }, 502);
  }

  let reading = (result.content || '').trim();
  let usedModel = first.usedModel;

  // 极少数情况下模型只返回了推理内容而没有正文，做一次兜底
  if (!reading && result.finish === 'length') {
    const again = await callWithFailover(key, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(question, body.cards) + '\n\n（请直接开始写，不要做任何分析铺垫。）' },
    ], Date.now());
    if (again.result && again.result.ok) {
      reading = (again.result.content || '').trim();
      usedModel = again.usedModel;
    }
  }

  if (!reading) {
    return json({ success: false, error: '这次没能读出内容，请再试一次。' }, 502);
  }

  return json({ success: true, reading }, 200, { 'X-Tarot-Model': usedModel });
}

export async function onRequestGet() {
  return json({ success: false, error: '请使用 POST 请求。' }, 405);
}
