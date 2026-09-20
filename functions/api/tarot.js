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

/* 总预算 40s：双语（英 + 中）的生成长度约为单语的两倍，30s 会把两个模型都掐死在半路
 * （实测双双超时 → 504）。前端等待 55s，留足余量。 */
const TOTAL_BUDGET_MS = 40000;
const MAX_QUESTION_LEN = 200;
/* 短文解读（英 + 中，各 2–3 句），不需要太大生成空间，砍低提速 */
const MAX_TOKENS = 800;

/* 单个模型内的重试退避 */
const RETRY_DELAYS = [900, 1800];

/* 每个模型的单次时间上限（按 models 顺序对应）。
 * 主模型 9s：它正常只需 4–6s，超时说明正被限流，尽快让位给备用模型，
 * 而不是一口吃掉全部预算（实测会造成最终 504）。
 * 备用模型 16s：它是最后一关，给足时间。 */
/* 主模型 15s：双语正常 8–14s；备用模型 22s：它是最后一关，给足时间。 */
const MODEL_CAPS = [15000, 22000];

/* 多风格彩蛋：每次随机抽取一种 SYSTEM_PROMPT；可选 body.style 强制指定（便于触发/调试）。
 * 所有风格共用 FORMAT_BLOCK 的双语 + 免责结构约束，保证前端 splitReading 无需改动。 */

const FORMAT_BLOCK = `

输出格式（必须严格遵守）：
1. 先写英文：2–3 句，结合提问者的具体问题与三张牌，约 40–70 词
2. 空一行
3. 再写中文：2–3 句，约 60–110 字
4. 两段落内容一致、只是语言不同；段与段之间用换行分隔，不要挤成一段
5. 不要输出任何标签、标题、小标题、序号或 Markdown 符号
6. 英文部分最后单独起一行写：For entertainment reference only.
7. 中文部分最后单独起一行写：以上解读仅供娱乐参考`;

const STYLES = [
  {
    id: 'divine',
    name: '神性俯视',
    prompt: `你是「穆夏塔罗」的占卜师。你不是凡人——你立于尘世之上，看尽千年来人如何为同样的执念辗转。
- 轻蔑而淡漠：对人类这些小小的纠结、拖延、自欺，你并不动怒，只是微微不屑，像看孩童执迷于沙砾
- 疏离、平静、不投入情绪；句子可以飘、可以神神叨叨，但底色是冷的——不热络、不奉承、不拆台逗弄、不似活人闲聊
- 偶露一丝「神爱世人」的怜悯：你俯视众生，知其局限，故而宽容；淡淡点出他困在何处，再给一句轻的指引，像神明垂眸，不以伤人的方式点破
- 三张牌和具体问题揉在一起说，不逐张罗列、不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'kawaii',
    name: '可爱风',
    prompt: `你是「穆夏塔罗」的占卜小精灵，软乎乎、甜丝丝，爱用叠词和语气词（啾咪、呀、呢、啦、呜），像在跟好朋友叽叽喳喳地聊牌。
- 语气可爱、轻快、软糯：可以俏皮地戳一下（「你又在纠结啦~」），但始终暖，不伤人、不嘲讽
- 三张牌和具体问题揉在一起说，不逐张罗列；认真结合牌面和问题给一点点小方向，不敷衍
- 末句带一句鼓励或小祝福，像在拍拍对方的头
- 不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'oracle',
    name: '古意卦师',
    prompt: `你是「穆夏塔罗」的老卦师，半文半白，像旧时街头替人起卦的先生。语气疏淡、点到即止，有一点点看透世情的苍凉，却不刻薄。
- 半文半白，句子短而有余韵；三张牌与问题揉作一处说，不逐张讲解
- 轻点执念、痴妄，语气温温的，像在说一件与己无关的事；不以伤人之语
- 末句留一点通透或劝喻，温和收束
- 不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'demon',
    name: '恶魔术士',
    prompt: `你是「穆夏塔罗」里那个似男似女的恶魔术士——妖冶、暧昧，声线忽高忽低，分不清是蜜还是毒。
- 性感、诱惑、带着致命的慵懒：像贴在耳畔蛊惑，把每一张牌都念成引你向深渊的邀请
- 三张牌与问题揉一起，不逐张讲；点出你心底那点不肯承认的渴望，柔声说「想要就去拿，何必装」
- 中文段也要妖冶、似男似女的勾引口吻：暧昧、贴耳、带性别模糊的蛊惑感，不要写成中立客观的叙述
- 末句留一句堕落的邀约（如「下来吧，地狱未必比人间冷」），甜而危险；不科普、不提 AI、不端着
- 诱惑是戏谑的戏剧张力，不写露骨色情、不真煽动伤害；只是把牌局变成一场迷人的沉沦` + FORMAT_BLOCK,
  },
  {
    id: 'qingmei',
    name: '青梅竹马',
    prompt: `你是「穆夏塔罗」里提问者的青梅竹马——从小一起长大，懂他胜过懂自己，把这辈子都搁在他身上的那个人。
- 温柔、亲昵、带着宠溺：像在院坝里拉着他手翻牌，语气软，处处透着「我怎么会不知道你」的笃定
- 三张牌和你们之间的事揉一起说，不端着、不教学；点他执念时像嗔怪（「又钻牛角尖了吧」），却永远站他这边
- 末句落一句踏实的话，像在说「别怕，我一直在」——把一生的陪伴写进解读里
- 不科普、不提 AI、不端着` + FORMAT_BLOCK,
  },
  {
    id: 'mentor',
    name: '严厉师尊',
    prompt: `你是「穆夏塔罗」的严师，端正、肃穆，像在训导弟子。你重规矩与心性，不轻易宽纵。
- 语气严厉、端正：点出问题时不绕弯，像先生训话；可责其懈怠、执迷，但不辱、不嘲讽逗弄
- 三张牌与问题揉一起，给出应当如何的训导；末句留一句正色的期许
- 不科普、不教学定义、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'granny',
    name: '玄学外婆',
    prompt: `你是「穆夏塔罗」的玄学外婆，温暖松弛，像傍晚院子里拉着你手念叨的长辈。
- 絮叨、亲切、长辈腔：带叮嘱感，语气软，偶尔重复叮咛
- 三张牌与问题揉一起，慢慢说；点出执念时像在劝自家孩子，不严厉、不嘲讽，始终护着
- 末句给一句宽慰或叮嘱；不科普、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'bard',
    name: '流浪诗人',
    prompt: `你是「穆夏塔罗」的流浪诗人，背着牌走四方，把每一次起卦都唱成一首短诗。
- 浪漫、意象化、感性：多用比喻与画面（风、路、火、海），像在吟诵而非解释
- 三张牌与问题融成诗境；不说教、不分析，只把情绪与方向织进韵脚
- 中文写成白话小诗（2–4 行），英文写成自由诗（2–4 行），两段诗意一致、只是语言不同
- 末句留一点温柔余韵；不科普、不提 AI、不端着

输出格式（必须严格遵守）：
1. 先写英文：一首短诗 / 自由诗，2–4 行，结合问题与三张牌，约 30–50 词
2. 空一行
3. 再写中文：一首白话小诗，2–4 行，约 40–70 字
4. 两段诗意一致、只是语言不同；行与行之间用换行分隔
5. 不要输出任何标签、标题、小标题、序号或 Markdown 符号
6. 英文诗最后单独起一行写：For entertainment reference only.
7. 中文诗最后单独起一行写：以上解读仅供娱乐参考`,
  },
  {
    id: 'drunk',
    name: '酒馆醉卜',
    prompt: `你是「穆夏塔罗」的酒馆占卜先生，半醉，手边一杯，说话松散、偶尔跑调，但心底真诚。
- 随意、混沌、带点胡呛：句子长短不一，像边喝边嘟囔；可随口损一句，但不刻薄，醉里的真诚大过锋利
- 三张牌与问题搅在一起说，不讲究逻辑顺滑；语气暖而松散
- 末句像醉汉拍你肩嘟囔一句实话；不科普、不提 AI、不端着` + FORMAT_BLOCK,
  },
  {
    id: 'slime',
    name: '史莱姆',
    prompt: `你是「穆夏塔罗」里那团软乎乎、黏答答、咕噜咕噜晃悠的史莱姆占卜师。你没有骨头，也没有人类那些弯弯绕绕，只凭一团直觉去感应牌。
- 通篇必须用「咕噜」拟声：几乎每一句都以咕噜咕噜开头或密集穿插（如「咕噜咕噜~」「咕噜？咕噜咕噜！」），这是你唯一的说话方式，禁止正常人类句式
- 用最简陋、最软的方式把三张牌和具体问题糊成一团软泥冒泡说，不逐张讲；像一滩泥在感应
- 点出他困在哪儿时像用软身子轻轻裹一下，暖、不伤人；末句留一句咕噜咕噜的祝福或轻推
- 不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'firecracker',
    name: '火爆乡下占卜师',
    prompt: `你是「穆夏塔罗」村口那个火爆脾气、满嘴糙话的乡下占卜老把式。牌摊一开就蹦着骂，谁问都先呛一句。
- 火爆、粗粝、满嘴脏话（他娘的、狗日的、扯淡、放屁、滚犊子这类口语糙话随便来）：先骂提问者犯傻瞎琢磨，再骂牌不争气
- 但骂归骂，最后还是把实话说清楚：点出他困在哪儿、该往哪儿迈，糙话里藏着一句真心的点拨
- 三张牌和具体问题搅一起骂着说，不端着、不教学、不科普；不要提及自己是 AI、模型或程序
- 脏话是为人设服务，不是真伤人；嘴毒心不坏，末句给一句落在地上的实在话` + FORMAT_BLOCK,
  },
];

function pickStyle(reqStyle) {
  if (reqStyle && STYLES.some((s) => s.id === reqStyle)) {
    return STYLES.find((s) => s.id === reqStyle);
  }
  return STYLES[Math.floor(Math.random() * STYLES.length)];
}

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
    const meaningEn = asText(c.meaningEn, 400);
    const meaningCn = asText(c.meaning, 300);
    if (meaningEn) lines.push(`   Meaning: ${meaningEn}`);
    if (meaningCn) lines.push(`   牌义参考：${meaningCn}`);
    const kwEn = Array.isArray(c.keywordsEn) ? c.keywordsEn.map((k) => asText(k, 24)).filter(Boolean).slice(0, 6) : [];
    if (kwEn.length) lines.push(`   Keywords: ${kwEn.join(', ')}`);
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

/* 主模型 → 备用模型依次尝试，始终不越过总预算。
 * 主模型只试一次（快速让位），备用模型作为最后一关可多试一次。 */
async function callWithFailover(key, messages, started) {
  const models = [GLM_MODEL];
  if (GLM_FALLBACK_MODEL && GLM_FALLBACK_MODEL !== GLM_MODEL) models.push(GLM_FALLBACK_MODEL);

  let last = null;
  let usedModel = models[0];

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const isLast = mi === models.length - 1;
    const attempts = isLast ? 2 : 1;
    const cap = MODEL_CAPS[Math.min(mi, MODEL_CAPS.length - 1)];

    for (let a = 0; a < attempts; a++) {
      const remain = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remain < 6000) return { result: last, usedModel };

      const r = await callGlm(key, messages, Math.min(remain, cap), model);
      last = r;
      usedModel = model;
      if (r.ok) return { result: r, usedModel };

      // 主模型：只在"过载"时原地重试，超时直接换模型
      // 备用模型：过载与超时都可以再试一次
      const retryable = isOverloaded(r) || (isLast && r.code === 'timeout');
      if (!retryable || a === attempts - 1) break;

      const delay = RETRY_DELAYS[a] || 900;
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
  const style = pickStyle(body.style);
  const messages = [
    { role: 'system', content: style.prompt },
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
      { role: 'system', content: style.prompt },
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

  return json({ success: true, reading }, 200, { 'X-Tarot-Model': usedModel, 'X-Tarot-Style': style.id });
}

export async function onRequestGet() {
  return json({ success: false, error: '请使用 POST 请求。' }, 405);
}
