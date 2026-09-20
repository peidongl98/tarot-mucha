/* js/app.js — Mucha Tarot · 主逻辑
 *
 * 依赖：
 *   js/data.js       -> TAROT_CARDS / TAROT_BY_ID（全局，经典脚本）
 *   data/meanings.js -> TAROT_MEANINGS（全局）
 *   js/scene.js      -> createTarotScene（ES module）
 *   window.gsap（CDN，UMD 全局）
 *
 * 流程（状态机）：
 *   opening  初始：单张牌背（可跟随指针）+ 顶部光球 + 花体标题
 *   ask      点牌背 → 扇形展开 + 标题淡出 + 问句/输入/提示/光圈浮现
 *   deal     点光圈 → 光球处理 + 扇形退场 + 三张牌飞到中央（背面朝上）
 *   row      三张并列：点一张翻面；再点已翻开的牌 → 放大看牌义
 *   zoom     某张放大中（牌义浮出）
 *   reading  上滑 → 三张固定到顶部 + 解读光圈 + 解读文字 + 返回光球
 *   ending   长按返回光球 → 炸成星光 + 飞行 + 生成新记录 + 回到开场
 *
 * 数据：localStorage 键 tarot_orbs，保留最近 3 次
 *   { at, question, cards: [{ id, position, reversed }], reading }
 *
 * 不引入框架、零构建；页面本身不滚动（所有内容切换都在一屏内完成）。
 */

import { createTarotScene } from './scene.js';

const MAX_QUESTION_LEN = 200;
const POSITIONS = ['Past', 'Present', 'Future'];
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* 顶部光球：本地仅展示最新 ORB_MAX 条（滚动窗口）；云端 D1 存全部（最多 CAP 条，见 functions/api/orbs.js）。
 * 删除 = 仅本地：把 at 记入本地隐藏集，云端记录保持不动（"线上记录一直在"）。 */
const ORB_MAX = 3;
const ORB_KEY = 'tarot_orbs';
const ORBS_HIDDEN_KEY = 'tarot_orbs_hidden';   // 本地已删除（仅隐藏）的 at 列表，云端仍保留
const DEVICE_KEY = 'tarot_device_id';   // 匿名设备标识，用于云端按设备隔离记录
/* 更早版本用 localStorage 存抽牌历史列表，那套 UI 已移除；顺手清掉遗留键 */
const LEGACY_KEY = 'tarot_history';

const HOLD_MS = 1500;          // 长按返回光球（Seal）的时长：进度与光球变亮同步
const DRAG_SLOP = 12;          // 按下到抬起的位移阈值（px）：超过就算拖动，不算点击

/* 卡牌图路径：优先用 cards/w/*.webp（约 54KB/张，原 jpg 约 344KB/张，首抽从 ~1MB 降到 ~160KB）。
 * 探测一下 WebP 支持，不支持则回退原始 jpg，保证兼容性。 */
const WEBP_OK = (() => {
  try { return document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0; }
  catch (e) { return false; }
})();
function cardSrc(file) {
  if (WEBP_OK) return 'cards/w/' + file.replace(/\.(jpg|jpeg|png)$/i, '.webp');
  return 'cards/' + file;
}
function backSrc() {
  return WEBP_OK ? 'cards/w/back.webp' : 'cards/back.jpg';
}

/* 滚筒：角度由前端统一持有（3D 与降级模式共用同一套交互）。
 * 交互 = 点击左右发光三角形换牌（无拖动、无滚轮、无滑动）。 */
const WHEEL_STEP = (Math.PI * 2) / 3;   // 相邻两牌的角距（120°）
const wheel = { a: 0, tween: null };

/* 状态机 */
const S = { OPENING: 'opening', ASK: 'ask', DEAL: 'deal', ROW: 'row', ZOOM: 'zoom', READING: 'reading', ENDING: 'ending' };
let state = S.OPENING;

/* 运行时数据 */
const el = {};
let scene = null;
let lastReading = null;        // [{ id, reversed, position }]
let lastQuestion = '';
let lastAiText = '';
let cardsFlipped = [false, false, false];
let zoomIndex = -1;
let aiBusy = false;
let openingOpened = false;     // 扇形是否已展开过
let deckShown = true;          // 单张牌背是否在场（用于对齐点击区）
let ringActive = false;
let records = [];              // localStorage 里的记录（旧 → 新）
let currentAt = null;          // 当前会话对应的记录时间戳（历史恢复时非空）
let fromHistory = false;       // 当前会话是否来自历史回看
let deckPressAt = null;
let holdTimer = null;

/* ============================================================
 * 工具
 * ============================================================ */

function elNew(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function randInt(max) {
  if (window.crypto && window.crypto.getRandomValues) {
    const a = new Uint32Array(1);
    const limit = Math.floor(4294967296 / max) * max;
    do { window.crypto.getRandomValues(a); } while (a[0] >= limit);
    return a[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/* Fisher-Yates 洗乱 78 张，取前 3 张 → 天然不重复；每张独立 50% 逆位 */
function drawThree() {
  const pool = shuffle(TAROT_CARDS.slice());
  return [0, 1, 2].map((i) => ({
    id: pool[i].id,
    reversed: randInt(2) === 1,
    position: POSITIONS[i],
  }));
}

function currentQuestion() {
  return el.question ? (el.question.value || '').trim().slice(0, MAX_QUESTION_LEN) : '';
}

/* ============================================================
 * 星光：一块 canvas 画两种效果
 *   ① 向外爆散（标题淡出、光球消失）
 *   ② 向一点汇聚（返回光球把牌与文字吸走）
 * 旧实现是 260 个 DOM 星点 + 双层 box-shadow，缩放时每帧重新栅格化模糊阴影，
 * 实测爆散期间均帧从 28.8ms 涨到 50.6ms；换成 canvas 后开销落到噪声内。
 * ============================================================ */

let burstRaf = 0;
let burstSprite = null;

function getStarSprite() {
  if (burstSprite) return burstSprite;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, 'rgba(255,252,246,1)');
  rg.addColorStop(0.3, 'rgba(237,232,224,0.85)');
  rg.addColorStop(0.55, 'rgba(201,169,97,0.45)');
  rg.addColorStop(1, 'rgba(201,169,97,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
  burstSprite = cv;
  return cv;
}

function openBurstCanvas() {
  const cv = el.burstLayer;
  if (!cv || !cv.getContext) return null;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth;
  const H = window.innerHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  cv.style.display = 'block';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}

function closeBurstCanvas(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  if (el.burstLayer) el.burstLayer.style.display = 'none';
}

function runParticles(stars, opts) {
  const o = opts || {};
  const g = openBurstCanvas();
  if (!g || !stars.length) return Promise.resolve();
  if (burstRaf) { cancelAnimationFrame(burstRaf); burstRaf = 0; }
  const sprite = getStarSprite();
  const { ctx, W, H } = g;
  const converge = !!o.converge;

  return new Promise((resolve) => {
    let last = 0;
    const step = (now) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        if (s.delay > 0) { s.delay -= dt; alive++; continue; }
        s.t += dt;
        const k = s.t / s.life;
        if (k >= 1) continue;
        alive++;
        let x; let y; let a; let r;
        if (converge) {
          const e = k * k * (3 - 2 * k);                 // 平滑靠拢
          x = s.x + (s.tx - s.x) * e;
          y = s.y + (s.ty - s.y) * e;
          a = Math.pow(1 - k, 1.25) * (k < 0.12 ? k / 0.12 : 1);
          r = s.r * (1 - 0.55 * k);
        } else {
          const out = 1 - Math.pow(1 - k, 2.4);          // 先快后慢地外扩
          x = s.x + s.vx * out;
          y = s.y + s.vy * out + 12 * out * out;
          a = Math.pow(1 - k, 1.5);
          r = s.r * (0.55 + 0.8 * out) * (1 - 0.35 * k);
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, a));
        ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      if (alive) {
        burstRaf = requestAnimationFrame(step);
      } else {
        burstRaf = 0;
        closeBurstCanvas(ctx, W, H);
        resolve();
      }
    };
    burstRaf = requestAnimationFrame(step);
  });
}

/* 向外爆散：points 是相对 rect 左上角的点 */
function burstOut(points, rect, count) {
  const n = count || 26;
  const step = Math.max(1, Math.floor(points.length / n));
  const stars = [];
  for (let i = 0; i < points.length && stars.length < n; i += step) {
    const p = points[i];
    const a = Math.random() * Math.PI * 2;
    const d = 44 + Math.random() * 150;
    stars.push({
      x: rect.left + p.x,
      y: rect.top + p.y,
      vx: Math.cos(a) * d,
      vy: Math.sin(a) * d + 26,
      r: 3.4 + Math.random() * 3.4,
      t: 0, delay: Math.random() * 0.16,
      life: 0.7 + Math.random() * 0.6,
    });
  }
  return runParticles(stars, { converge: false });
}

/* 向一点汇聚：把若干矩形里的星点吸到 target（返回光球） */
function gatherTo(rects, target, perRect) {
  const n = perRect || 11;
  const stars = [];
  rects.forEach((r) => {
    if (!r || !r.width && !r.w) return;
    const box = { x: r.x != null ? r.x : r.left, y: r.y != null ? r.y : r.top, w: r.w != null ? r.w : r.width, h: r.h != null ? r.h : r.height };
    if (box.w < 2 || box.h < 2) return;
    for (let i = 0; i < n; i++) {
      stars.push({
        x: box.x + Math.random() * box.w,
        y: box.y + Math.random() * box.h,
        tx: target.x + (Math.random() - 0.5) * 12,
        ty: target.y + (Math.random() - 0.5) * 12,
        r: 2.4 + Math.random() * 2.6,
        t: 0,
        delay: Math.random() * 0.22,
        life: 0.8 + Math.random() * 0.5,
      });
    }
  });
  return runParticles(stars, { converge: true });
}

/* ============================================================
 * 标题：淡出 + 少量星光（等 webfont 就绪再采样字形）
 * ============================================================ */

function sampleTitlePoints(node, rect, limit) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(1, Math.round(rect.width * dpr));
  const chh = Math.max(1, Math.round(rect.height * dpr));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = chh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  const cs = getComputedStyle(node);
  ctx.scale(dpr, dpr);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';

  // 逐字绘制并手动累加字距，才能和 DOM 上的 letter-spacing 对齐
  const text = (node.textContent || '').trim();
  const ls = parseFloat(cs.letterSpacing) || 0;
  const chars = Array.from(text);
  const widths = chars.map((c) => ctx.measureText(c).width + ls);
  const total = widths.reduce((a, b) => a + b, 0) - ls;

  let x = (rect.width - total) / 2;
  chars.forEach((c, i) => {
    ctx.fillText(c, x, rect.height / 2);
    x += widths[i];
  });

  let data;
  try { data = ctx.getImageData(0, 0, cw, chh).data; } catch (e) { return []; }

  const step = Math.max(2, Math.round(2 * dpr));
  const pts = [];
  for (let py = 0; py < chh; py += step) {
    for (let px = 0; px < cw; px += step) {
      if (data[(py * cw + px) * 4 + 3] > 110) pts.push({ x: px / dpr, y: py / dpr });
    }
  }
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pts[i]; pts[i] = pts[j]; pts[j] = t;
  }
  return pts.slice(0, limit || 26);
}

async function fadeTitle() {
  const node = el.openingTitle;
  if (!node || node.dataset.gone === '1') return;
  node.dataset.gone = '1';

  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* 忽略 */ }
  const rect = node.getBoundingClientRect();
  const points = sampleTitlePoints(node, rect, 26);

  if (REDUCED) { node.style.visibility = 'hidden'; return; }
  if (window.gsap) {
    window.gsap.to(node, {
      opacity: 0, duration: 0.8, ease: 'power2.inOut',
      onComplete: () => { node.style.visibility = 'hidden'; },
    });
  } else {
    node.style.visibility = 'hidden';
  }
  if (points.length) burstOut(points, rect, 26);
}

/* ============================================================
 * 顶部光球：展示 / 处理 / 新记录挤入
 * ============================================================ */

function readOrbs() {
  try {
    const raw = localStorage.getItem(ORB_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => r && r.cards && r.cards.length === 3) : [];
  } catch (e) {
    return [];
  }
}

function writeOrbs(list) {
  try { localStorage.setItem(ORB_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
}

/* 本地隐藏集：记录被「本地删除」的 at（云端仍有，只是本机不显示）。
 * 这样刷新后云端拉取不会把已删的重新拉回来，而线上记录始终保留。 */
function loadHidden() {
  try {
    const raw = localStorage.getItem(ORBS_HIDDEN_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch (e) { return new Set(); }
}

function addHidden(at) {
  if (!at) return;
  const s = loadHidden();
  s.add(String(at));
  saveHidden(s);
}

function saveHidden(set) {
  try { localStorage.setItem(ORBS_HIDDEN_KEY, JSON.stringify(Array.from(set || []))); } catch (e) { /* 忽略 */ }
}

/* 匿名设备标识：本地生成一次，存 localStorage；云端按此隔离记录，无需登录 */
function getDeviceId() {
  let id = '';
  try { id = localStorage.getItem(DEVICE_KEY) || ''; } catch (e) { /* ignore */ }
  if (!id) {
    try {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ('d-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    } catch (e) { id = 'd-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { /* ignore */ }
  }
  return id;
}

/* 云端同步：全部 best-effort、fire-and-forget，失败静默回退 localStorage。
 * 未配置 D1 绑定（env.DB 为空）时 /api/orbs 返回 backend:false，调用方据此忽略。 */
const ORBS_API = '/api/orbs';

function cloudPush(rec) {
  if (!rec || !rec.at || !Array.isArray(rec.cards) || rec.cards.length !== 3) return;
  const payload = {
    device_id: getDeviceId(),
    at: rec.at,
    question: rec.question || '',
    cards: rec.cards,
    reading: rec.reading || '',
  };
  try {
    fetch(ORBS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* 忽略：本地优先 */ }
}

/* 本地删除的云端落点：标记 hidden=1（记录不删，线上一直在）。
 * 隐藏集持久化到云端，因此清本地缓存后 cloudPull 仍会排除该条 —— 与本地解绑。 */
function cloudHide(at) {
  if (!at) return;
  const url = ORBS_API + '?device_id=' + encodeURIComponent(getDeviceId()) +
    '&at=' + encodeURIComponent(String(at));
  try {
    fetch(url, { method: 'PATCH', keepalive: true }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/* 拉取云端全量（≤50）；无云端或出错返回 null，调用方保留本地列表 */
function cloudPull() {
  const url = ORBS_API + '?device_id=' + encodeURIComponent(getDeviceId());
  try {
    return fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((d) => (d && d.success && d.backend && Array.isArray(d.orbs)) ? d.orbs : null)
      .catch(() => null);
  } catch (e) { return Promise.resolve(null); }
}

function setRect(node, r) {
  if (!node) return;
  if (!r) { if (!node.hidden) node.hidden = true; return; }
  if (node.hidden) node.hidden = false;
  node.style.left = r.x + 'px';
  node.style.top = r.y + 'px';
  node.style.width = r.w + 'px';
  node.style.height = r.h + 'px';
}

/* 渲染光球；opts.animateNew 时用 FLIP 做「新球挤入 + 旧球被挤动」 */
function renderOrbs(list, opts) {
  if (!el.orbRow) return [];
  const o = opts || {};
  const items = (Array.isArray(list) ? list : []).filter(Boolean).slice(-ORB_MAX);

  const prev = new Map();
  if (o.animateNew) {
    Array.prototype.forEach.call(el.orbRow.querySelectorAll('.orb'), (n) => {
      prev.set(n.dataset.at, n.getBoundingClientRect());
    });
  }

  el.orbRow.textContent = '';
  const nodes = items.map((rec, i) => {
    const orb = elNew('span', 'orb' + (items.length > 1 && i === 0 ? ' is-aging' : ''));
    orb.dataset.at = String(rec.at);
    orb.dataset.index = String(i);
    orb.setAttribute('role', 'button');
    orb.setAttribute('tabindex', '0');
    orb.setAttribute('aria-label', '回看第 ' + (i + 1) + ' 次抽牌');
    el.orbRow.appendChild(orb);
    return orb;
  });

  el.orbRow.hidden = items.length === 0;
  el.orbRow.dataset.count = String(items.length);
  el.orbRow.classList.remove('is-dim');

  const gsap = window.gsap;

  if (o.animateNew && gsap && !REDUCED) {
    nodes.forEach((n) => {
      const before = prev.get(n.dataset.at);
      const after = n.getBoundingClientRect();
      if (before) {
        const dx = before.left - after.left;
        if (Math.abs(dx) > 0.5) gsap.fromTo(n, { x: dx }, { x: 0, duration: 1.0, ease: 'elastic.out(1, 0.62)' });
      } else {
        gsap.fromTo(n,
          { x: 52, scale: 0.35, opacity: 0 },
          { x: 0, scale: 1, opacity: 1, duration: 1.1, ease: 'elastic.out(1, 0.55)' });
      }
    });
  } else if (items.length) {
    if (gsap && !REDUCED && o.fadeIn !== false) {
      gsap.fromTo(el.orbRow, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 1.0, ease: 'power3.out', delay: 0.3 });
    } else {
      el.orbRow.style.opacity = '1';
    }
  }
  return nodes;
}

/* 剩余光球变黯淡 + 缓慢漂浮（抽牌时） */
function dimOrbs(on) {
  if (!el.orbRow) return;
  el.orbRow.classList.toggle('is-dim', !!on);
}

/* 光球显隐：只在首页（OPENING）显示，离开即淡出；
 * 其他状态（ASK / 抽牌 / 看牌 / 解读 / 历史回看）一律隐藏。 */
function setOrbsVisible(on) {
  if (!el.orbRow) return;
  if (on) {
    if (el.orbRow.childElementCount === 0) { el.orbRow.hidden = true; return; }
    el.orbRow.hidden = false;
    el.orbRow.classList.remove('is-dim', 'is-hidden');
    el.orbRow.style.opacity = '1';
  } else {
    el.orbRow.classList.remove('is-dim');
    el.orbRow.classList.add('is-hidden');
  }
}

/* 最旧的光球炸成星光后消失 */
async function burstOldestOrb() {
  const first = el.orbRow ? el.orbRow.querySelector('.orb') : null;
  if (!first) return false;
  const r = first.getBoundingClientRect();
  if (!r.width) return false;
  const pts = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const rr = (i % 5) * 1.7;
    pts.push({ x: r.width / 2 + Math.cos(a) * rr, y: r.height / 2 + Math.sin(a) * rr });
  }
  first.remove();
  const left = el.orbRow.querySelectorAll('.orb').length;
  el.orbRow.dataset.count = String(left);
  if (!left) el.orbRow.hidden = true;
  if (REDUCED) return true;
  await burstOut(pts, r, 22);
  return true;
}

/* ---------- 首页光球：长按激活 → 半圆弧流光 → 拖出即删除 ---------- */
const ORB_DELETE_DRAG = 88;        // 拖离原位超过此距离（px）即删除
const ORB_DRAG_SCALE = 2.4;        // 拖拽态放大倍数（与 CSS --orb-drag-scale 保持一致）
let orbDel = null;                 // { orb, rec, pid, originX, originY, dx, dy, moved, committed }
let suppressOrbClick = false;

function positionArcAt(orb, x, y) {
  if (!el.orbDeleteArc) return;
  let px = x, py = y;
  if (px == null || py == null) {
    const target = orb || (el.orbRow && el.orbRow.querySelector('.orb'));
    if (!target) return;
    const r = target.getBoundingClientRect();
    px = r.left + r.width / 2;
    py = r.top + r.height / 2;
  }
  el.orbDeleteArc.style.left = px + 'px';
  el.orbDeleteArc.style.top = py + 'px';
}
function showOrbArc(orb) {
  positionArcAt(orb);
  if (el.orbDeleteArc) el.orbDeleteArc.classList.add('is-on');
}
function hideOrbArc() {
  if (el.orbDeleteArc) el.orbDeleteArc.classList.remove('is-on', 'is-danger', 'is-hint');
}

/* 呼吸涟漪 & 删除弧提示：仅在首页、未减弱动效、无进行中删除时随机触发 */
let orbFxTimer = null;
function orbFxLoop() {
  if (orbFxTimer) clearTimeout(orbFxTimer);
  orbFxTimer = setTimeout(() => {
    if (state === S.OPENING && !orbDel && !REDUCED && el.orbRow && !el.orbRow.hidden) {
      const orbs = el.orbRow.querySelectorAll('.orb');
      if (orbs.length) {
        const pick = orbs[Math.floor(Math.random() * orbs.length)];
        if (Math.random() < 0.62) spawnOrbRipple(pick);
        else hintOrbArc(pick);
      }
    }
    orbFxLoop();
  }, 5000 + Math.random() * 7000);
}
function spawnOrbRipple(orb) {
  if (!orb || REDUCED) return;
  const r = orb.getBoundingClientRect();
  const d = document.createElement('div');
  d.className = 'orb-ripple';
  const size = Math.max(r.width, r.height) * 1.5;
  d.style.width = size + 'px';
  d.style.height = size + 'px';
  d.style.left = (r.left + r.width / 2) + 'px';
  d.style.top = (r.top + r.height / 2) + 'px';
  document.body.appendChild(d);
  d.addEventListener('animationend', () => { if (d.parentNode) d.remove(); });
  setTimeout(() => { if (d.parentNode) d.remove(); }, 2200);   /* 兜底移除 */
}
function hintOrbArc(orb) {
  if (!orb || orbDel || !el.orbDeleteArc) return;
  positionArcAt(orb);
  el.orbDeleteArc.classList.add('is-on', 'is-hint');
  setTimeout(() => {
    if (el.orbDeleteArc && !orbDel) el.orbDeleteArc.classList.remove('is-on', 'is-hint');
  }, 950);
}

function onOrbPointerDown(e) {
  if (state !== S.OPENING || orbDel) return;
  const orb = e.target && e.target.closest ? e.target.closest('.orb') : null;
  if (!orb || !orb.dataset.at) return;
  const rec = records.filter((r) => String(r.at) === orb.dataset.at)[0];
  if (!rec) return;
  e.preventDefault();
  try { orb.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  const r = orb.getBoundingClientRect();
  orbDel = {
    orb, rec, pid: e.pointerId,
    originX: r.left + r.width / 2, originY: r.top + r.height / 2,
    dx: 0, dy: 0, moved: false, committed: false, _home: null,
  };
  document.body.classList.add('orb-deleting');   // 禁用容器手势，保证 pointermove 连续
  orb.classList.add('is-del-flash');
  showOrbArc(orb);
}

/* 拖出时把光球提到 body 顶层，逃离滚动容器的 overflow 裁剪（否则向下拖会消失） */
function liftOrbToBody(orb) {
  if (!orb || orbDel._home) return;
  const r = orb.getBoundingClientRect();
  orbDel._home = { parent: orb.parentNode, next: orb.nextSibling };
  orbDel._w = r.width; orbDel._h = r.height;   // 记录含 padding 的实测尺寸
  orb.style.position = 'fixed';
  orb.style.left = r.left + 'px';
  orb.style.top = r.top + 'px';
  orb.style.width = r.width + 'px';
  orb.style.height = r.height + 'px';
  orb.style.margin = '0';        // 已用固定定位，清掉负 margin（宽度补上差值即可）
  orb.style.boxSizing = 'border-box';
  orb.style.zIndex = '60';
  document.body.appendChild(orb);
}

function onOrbDeleteMove(e) {
  if (!orbDel || orbDel.committed) return;
  const dx = e.clientX - orbDel.originX;
  const dy = e.clientY - orbDel.originY;
  orbDel.dx = dx; orbDel.dy = dy;
  if (!orbDel.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    orbDel.moved = true;
    liftOrbToBody(orbDel.orb);            // 首次移动即脱离滚动容器
    orbDel.orb.classList.remove('is-del-flash');
    orbDel.orb.classList.add('is-del-drag');
  }
  if (orbDel.moved) {
    orbDel.orb.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + ORB_DRAG_SCALE + ')';
    /* 穹顶（删除圈）实时跟随球中心：球一旦移出圈外即炸成光 */
    positionArcAt(null, orbDel.originX + dx, orbDel.originY + dy);
  }
  const dist = Math.hypot(dx, dy);
  /* 穹顶直径 = 球径*5（SVG r=46/100 → 实心圆约 0.92 倍容器宽）。判定半径取穹顶内圈，
   * 即「球移出这个圈」就炸成光。 */
  const arcR = el.orbDeleteArc ? el.orbDeleteArc.offsetWidth * 0.46 : ORB_DELETE_DRAG;
  const threshold = Math.min(ORB_DELETE_DRAG, arcR);
  if (el.orbDeleteArc) el.orbDeleteArc.classList.toggle('is-danger', dist > threshold * 0.62);
  if (dist > threshold) commitOrbDelete();
}

function onOrbDeleteUp() {
  if (!orbDel || orbDel.committed) return;
  cancelOrbDelete();                      // 松手未拖出 → 回弹取消
}

function commitOrbDelete() {
  if (!orbDel || orbDel.committed) return;
  orbDel.committed = true;
  const { orb, rec } = orbDel;
  const r = orb.getBoundingClientRect();
  const pts = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const rr = (i % 5) * 1.7;
    pts.push({ x: r.width / 2 + Math.cos(a) * rr, y: r.height / 2 + Math.sin(a) * rr });
  }
  records = records.filter((x) => String(x.at) !== String(rec.at));
  writeOrbs(records);
  addHidden(rec.at);                    // 本地隐藏集（无云端时降级也生效）
  cloudHide(rec.at);                   // 云端标 hidden=1：清缓存也不复活
  document.body.classList.remove('orb-deleting');
  hideOrbArc();
  if (orb && orb.parentNode) orb.parentNode.removeChild(orb);   // 移除被拖出的副本（renderOrbs 重建）
  orbDel = null;
  if (!REDUCED) burstOut(pts, r, 24);    // 炸成光点
  renderOrbs(records, { animateNew: false });
  suppressOrbClick = true;               // 阻止随后误触的 click 回看
  window.setTimeout(() => { suppressOrbClick = false; }, 60);
}

function cancelOrbDelete() {
  if (!orbDel) return;
  const { orb, dx, dy } = orbDel;
  document.body.classList.remove('orb-deleting');
  hideOrbArc();
  orb.classList.remove('is-del-flash', 'is-del-drag');
  const gsap = window.gsap;
  const home = orbDel._home;
  if (home && home.parent) { try { home.parent.insertBefore(orb, home.next); } catch (e) { /* ignore */ } }
  orb.style.position = '';
  orb.style.left = '';
  orb.style.top = '';
  orb.style.width = '';
  orb.style.height = '';
  orb.style.margin = '';
  orb.style.boxSizing = '';
  orb.style.zIndex = '';
  if (gsap && !REDUCED) {
    gsap.fromTo(orb, { x: dx, y: dy, scale: ORB_DRAG_SCALE },
      { x: 0, y: 0, scale: 1, duration: 0.32, ease: 'power3.out', onComplete: () => { orb.style.transform = ''; } });
  } else {
    orb.style.transform = '';
  }
  orbDel = null;
}

/* ============================================================
 * 开场：点牌背展开扇形
 * ============================================================ */

function onDeckPointerDown(e) {
  deckPressAt = { x: e.clientX, y: e.clientY };
}

function onDeckClick(e) {
  if (!deckShown) return;
  const moved = deckPressAt ? Math.hypot(e.clientX - deckPressAt.x, e.clientY - deckPressAt.y) : 0;
  deckPressAt = null;
  if (moved > DRAG_SLOP) return;         // 拖动 = 在"摸"牌看倾斜，不当作点击
  openFan();
}

function openFan() {
  if (openingOpened) return;
  openingOpened = true;
  deckShown = false;
  if (el.deckHit) el.deckHit.hidden = true;
  if (scene && scene.ok) scene.openingFan();
  if (window.gsap && !REDUCED) window.gsap.delayedCall(0.06, fadeTitle);
  else fadeTitle();
  showAskArea();
  state = S.ASK;
  setOrbsVisible(false);          // 离开首页：光球淡出
}

/* 问句 / 输入 / 提示 / 光圈：只在「状态 2（点牌背后）」出现。
 * 状态 1（开场）、状态 3+（抽牌后）、历史回看里都必须完全隐藏（含 visibility，
 * 否则透明输入框会挡住底下牌背的点击）。 */
function setAskVisible(on, instant) {
  const targets = [el.openingQuestion, el.openingHint, el.ringBtn].filter(Boolean);
  const gsap = window.gsap;
  if (on) {
    targets.forEach((n) => { n.style.visibility = ''; });
    if (el.openingField) el.openingField.style.visibility = '';
    if (!gsap || REDUCED || instant) {
      targets.forEach((n) => { n.style.opacity = '1'; n.style.transform = 'none'; });
      if (el.openingField) el.openingField.style.opacity = '1';
      focusOnDesktop();
      return;
    }
    /* 输入框只动 opacity：transform 留给键盘上浮（CSS var --kb）接管 */
    gsap.fromTo(targets,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 1.0, stagger: 0.16, ease: 'power3.out', delay: 0.55 });
    gsap.fromTo(el.openingField,
      { opacity: 0 },
      { opacity: 1, duration: 1.0, ease: 'power3.out', delay: 0.71, onComplete: focusOnDesktop });
    return;
  }
  if (instant || !gsap || REDUCED) {
    targets.forEach((n) => { n.style.opacity = '0'; n.style.visibility = 'hidden'; });
    if (el.openingField) { el.openingField.style.opacity = '0'; el.openingField.style.visibility = 'hidden'; }
    return;
  }
  return new Promise((res) => {
    gsap.to(targets, {
      opacity: 0, y: -10, duration: 0.6, stagger: 0.06, ease: 'power2.in',
      onComplete: () => { targets.forEach((n) => { n.style.visibility = 'hidden'; n.style.transform = ''; }); res(); },
    });
    if (el.openingField) {
      gsap.to(el.openingField, {
        opacity: 0, duration: 0.6, ease: 'power2.in',
        onComplete: () => { el.openingField.style.visibility = 'hidden'; },
      });
    }
  });
}

function showAskArea() { setAskVisible(true); }
function hideAskArea() { return setAskVisible(false) || Promise.resolve(); }

/* 花体标题：开场出现；点牌背后淡出成星光；历史进入时直接淡出 */
function showTitle(on) {
  const t = el.openingTitle;
  if (!t) return;
  const gsap = window.gsap;
  if (on) {
    delete t.dataset.gone;
    t.style.visibility = 'visible';
    if (gsap && !REDUCED) gsap.fromTo(t, { opacity: 0 }, { opacity: 1, duration: 1.2, ease: 'power3.out' });
    else t.style.opacity = '1';
    return;
  }
  if (t.dataset.gone === '1') return;
  t.dataset.gone = '1';
  if (gsap && !REDUCED) {
    gsap.to(t, { opacity: 0, duration: 0.5, ease: 'power2.in', onComplete: () => { t.style.visibility = 'hidden'; } });
  } else {
    t.style.visibility = 'hidden';
  }
}

/* 桌面端自动落焦点，用户可以直接开始打字；移动端不自动唤起键盘 */
function focusOnDesktop() {
  const fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (fine && el.question && !el.question.readOnly) {
    try { el.question.focus({ preventScroll: true }); } catch (e) { el.question.focus(); }
  }
}

/* 开场光圈：空态暗且静止，有字后变亮 + 涟漪扩散；输入框流光同步 */
function syncRing() {
  if (!el.ringBtn) return;
  const has = (el.question.value || '').trim().length > 0;
  if (el.openingField) el.openingField.classList.toggle('has-text', has);
  if (has === ringActive) return;
  ringActive = has;
  el.ringBtn.classList.toggle('is-active', has);
}

function setInputLocked(on) {
  if (!el.question) return;
  el.question.readOnly = !!on;
  if (on) { try { el.question.blur(); } catch (e) { /* 忽略 */ } }
}

/* ============================================================
 * 滚筒：角度 / 拖动 / 惯性 / 吸附
 * 左右拖动 → 改变角度（渲染循环逐帧摆位）；松手按惯性外推后吸附到最近的牌。
 * 拖动只换位置，不改变朝向 —— 翻没翻由 cardsFlipped 决定，必须点击才翻面。
 * ============================================================ */

function wheelSnapTo(target, dur) {
  const gsap = window.gsap;
  if (wheel.tween) { wheel.tween.kill(); wheel.tween = null; }
  if (Math.abs(target - wheel.a) < 1e-6) return;   // 已在目标角：不建补间，保持 resting
  if (!gsap || REDUCED) { wheel.a = target; return; }
  wheel.tween = gsap.to(wheel, {
    a: target, duration: dur || 0.8, ease: 'power3.out',   // 柔顺吸附，无弹簧回弹
    onComplete: () => { wheel.tween = null; },
  });
}

/* 把第 index 张牌转到居中位（取当前角度附近最近的等价角，避免绕远路） */
function wheelGoTo(index, dur) {
  const base = index * WHEEL_STEP;
  const twoPi = Math.PI * 2;
  const target = base + twoPi * Math.round((wheel.a - base) / twoPi);
  wheelSnapTo(target, dur || 0.75);
}

function wheelFocusedIndex() {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < 3; i++) {
    let d = (i * WHEEL_STEP - wheel.a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < bd) { bd = Math.abs(d); best = i; }
  }
  return best;
}

/* 第 i 张牌与居中位的对齐度（1 = 正居中；侧牌 ≈ -0.5） */
function wheelFocusCos(i) {
  let d = (i * WHEEL_STEP - wheel.a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return Math.cos(d);
}

const wheelResting = () => !wheel.tween;

/* 三角形切换：点右 → 右侧牌转入居中（Past→Present→Future 循环）；点左反向 */
function wheelStepTo(dir) {
  if (state !== S.ROW || zoomIndex >= 0) return;
  wheelGoTo(wheelFocusedIndex() + dir, 0.75);
}

/* ============================================================
 * 阶段 1：点光圈 → 抽牌
 * ============================================================ */

/* 抽牌动画兜底：最多等 ms，超时即 reject，由调用方强制进入看牌态，避免永久卡在 S.DEAL */
function dealTimeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('deal-timeout ' + ms)), ms));
}

async function startDraw() {
  if (state !== S.ASK) return;
  state = S.DEAL;

  lastQuestion = currentQuestion();
  cardsFlipped = [false, false, false];
  zoomIndex = -1;
  lastAiText = '';
  currentAt = null;
  fromHistory = false;

  wheel.a = 0;                                        // 过去居中开场
  if (wheel.tween) { wheel.tween.kill(); wheel.tween = null; }
  if (scene && scene.ok) scene.wheelApply(wheel.a);   // DEAL 期间 tickOverlay 不再同步，这里显式推一次
  setInputLocked(true);
  setInputFocused(false);
  resetKeyboardState();          // 离开提问环节：清暗淡 + 清键盘态残留
  showSink(false);
  setAiRingVisible(true);
  setAiThinking(false);

  const cards = drawThree();
  lastReading = cards;

  const sequence = (async () => {
    // ① 最旧光球炸成星光消失（与后续动画并行，不阻塞牌出场）
    const burstP = burstOldestOrb();
    setOrbsVisible(false);

    // ② 问句 / 输入 / 提示 / 光圈淡出
    const fade = hideAskArea();

    // ③ 扇形退场 + 三张牌飞向滚筒（背面朝上）—— 立即开播，不等光球炸星
    if (scene && scene.ok) {
      await scene.dealFromFan(cards.map((c) => ({
        src: cardSrc(TAROT_BY_ID[c.id].file),
        reversed: !!c.reversed,
      })));
    } else {
      layoutFallbackWheel();
    }
    await fade;
    await burstP.catch(() => {});
  })();

  try {
    await Promise.race([sequence, dealTimeout(7000)]);
  } catch (e) {
    console.warn('[startDraw] 抽牌动画未按时完成，强制进入看牌：', e && e.message);
    setOrbsVisible(false);
  } finally {
    if (el.burstLayer) el.burstLayer.style.display = 'none';
    if (state === S.DEAL) { state = S.ROW; updateHits(); }   // 绝不永久卡在 DEAL
  }
}

/* ============================================================
 * 阶段 2：看牌（翻面 / 放大看牌义）
 * ============================================================ */

function onCardHit(i) {
  if (state === S.READING) { exitReading(); return; }   // 点击顶部牌 → 回滚筒
  if (state === S.ZOOM) {
    if (zoomIndex === i) zoomOut();
    return;
  }
  if (state !== S.ROW) return;

  // 只有居中的那张可以交互；点侧牌 → 把它转到居中（自然行为，翻面仍须在居中位点击）
  const focused = wheelFocusedIndex();
  if (i !== focused || !wheelResting()) {
    if (i !== focused) wheelGoTo(i);
    return;
  }

  if (!cardsFlipped[i]) {
    cardsFlipped[i] = true;
    if (scene && scene.ok) scene.flipCard(i);
    setHitFace(i, true);
    if (cardsFlipped.every(Boolean)) {
      window.setTimeout(() => { if (state === S.ROW) showSink(true); }, 950);
    }
  } else {
    zoomIn(i);
  }
}

function zoomIn(i) {
  if (!lastReading || !lastReading[i]) return;
  state = S.ZOOM;
  zoomIndex = i;
  showSink(false);
  if (scene && scene.ok) scene.zoomCard(i, true);
  if (el.zoomLabel) {
    el.zoomLabel.textContent = POSITIONS[i];   // 牌上方金色身份文字
    el.zoomLabel.classList.add('is-on');
  }
  showMeaning(i);
}

function zoomOut() {
  const i = zoomIndex;
  if (i < 0) return;
  state = S.ROW;
  if (el.zoomLabel) el.zoomLabel.classList.remove('is-on');
  hideMeaning();
  if (scene && scene.ok) scene.zoomCard(i, false);
  zoomIndex = -1;
  if (cardsFlipped.every(Boolean)) showSink(true);
}

/* 牌义面板：英文在前、中文在后，与解读同款排版（英衬线略小偏淡，中系统栈略大） */
function showMeaning(i) {
  const meta = TAROT_BY_ID[lastReading[i].id];
  const cn = TAROT_MEANINGS[lastReading[i].id] || null;
  const en = (typeof TAROT_MEANINGS_EN !== 'undefined' && TAROT_MEANINGS_EN[lastReading[i].id]) || null;
  const rev = !!lastReading[i].reversed;

  const gEn = elNew('div', 'ai-group read-group-en');
  if (en || meta) gEn.appendChild(elNew('h2', 'read-name', (en && en.name) || meta.en || meta.name));
  gEn.appendChild(elNew('p', 'read-badge', rev ? 'REVERSED' : 'UPRIGHT'));
  if (en) {
    gEn.appendChild(elNew('p', 'read-keys', (rev ? en.revKeys : en.upKeys).join(' · ')));
    gEn.appendChild(elNew('p', 'read-text read-text-en', rev ? en.rev : en.up));
  }

  const gCn = elNew('div', 'ai-group read-group-cn');
  if (cn) {
    gCn.appendChild(elNew('p', 'read-keys', (rev ? cn.revKeys : cn.upKeys).join(' · ')));
    gCn.appendChild(elNew('p', 'read-text read-text-cn', rev ? cn.rev : cn.up));
  }

  el.cardRead.textContent = '';
  el.cardRead.appendChild(gEn);
  el.cardRead.appendChild(gCn);
  el.cardRead.classList.add('is-on');
}

function hideMeaning() {
  el.cardRead.classList.remove('is-on');
}

/* Sink 光圈：三张全翻开后浮现，点击进入解读 */
function showSink(on) {
  if (el.sinkZone) el.sinkZone.classList.toggle('is-on', !!on);
}

/* ============================================================
 * 阶段 3：上滑 → 解读
 * ============================================================ */

function enterReading() {
  if (state !== S.ROW) return;
  state = S.READING;
  setOrbsVisible(false);          // 进入解读：光球隐藏
  zoomIndex = -1;
  hideMeaning();
  showSink(false);
  if (scene && scene.ok) scene.setView('top');
  el.readingView.classList.add('is-on');
  el.returnOrb.classList.add('is-on');
  if (lastAiText) {
    showAiText(lastAiText, true);      // 缓存命中（重复进出 / 历史回看）：直接显示，不重复调用
  } else {
    clearAiText();
    setAiRingVisible(true);
    playAiRipple();                    // 自动播放一次涟漪，提示解读开始
    /* 全自动：视图落定后自动发起解读，无需任何操作 */
    window.setTimeout(() => { if (state === S.READING && !lastAiText) askAi(); }, 900);
  }
  updateHits();
}

function exitReading() {
  if (state !== S.READING) return;
  state = S.ROW;
  if (scene && scene.ok) scene.setView('row');
  el.readingView.classList.remove('is-on');
  el.returnOrb.classList.remove('is-on');
  if (cardsFlipped.every(Boolean)) showSink(true);
  updateHits();
}

function setAiThinking(on) {
  if (!el.aiRing) return;
  el.aiRing.classList.toggle('is-thinking', !!on);
}

function setAiRingVisible(on) {
  if (!el.aiRing) return;
  el.aiRing.classList.toggle('is-off', !on);
}

function clearAiText() {
  el.aiText.textContent = '';
  el.aiText.classList.remove('is-on');
}

/* 免责声明文案：模型输出、前端兜底、块尾剥离三处共用同一份常量，
 * 改文案时只改这里，不会漏改。 */
const NOTE_EN = 'For entertainment reference only.';
const NOTE_CN = '以上解读仅供娱乐参考';
const READING_NOTES = [NOTE_EN, NOTE_CN];

/* 解读分语种：先按空行分段（段内偶发的软换行合并回一段），
 * 再按语言归类 —— 含 ≥2 个 CJK 字符的段归中文，其余归英文。
 * 旧记录是纯中文，走同一路径（英文组为空 → 只显示中文）。 */
function splitReading(text) {
  const blocks = String(text)
    .split(/\r?\n\s*\r?\n/)                       // 空行 = 段落边界
    .map((b) => {
      let joined = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').trim();
      if (!joined) return null;
      /* 免责句可能出现在块尾，且两条（英文+中文）常常挨在同一个块里
       * （模型把 "For entertainment reference only." 与 "以上解读仅供娱乐参考"
       * 连写在末尾）。所以要从后往前反复摘，直到块尾不再是免责句为止，
       * 否则先匹配到中文那条、英文那条就残留在正文里。 */
      const notes = [];
      for (;;) {
        const hit = READING_NOTES.find((n) => joined.endsWith(n));
        if (!hit) break;
        notes.unshift(hit);
        joined = joined.slice(0, joined.length - hit.length).trim();
      }
      const note = notes[0] || '';
      if (!joined) return notes.length ? { text: '', note } : null;
      return { text: joined, note };
    })
    .filter(Boolean);

  const enRaw = [];
  const cn = [];
  let enNote = '';
  let cnNote = '';
  blocks.forEach((p) => {
    if (p.note) {
      if (/entertainment/i.test(p.note)) { if (!enNote) enNote = p.note; }
      else if (!cnNote) cnNote = p.note;
      if (!p.text) return;                        // 免责单独成块：正文跳过
    }
    if (!p.text) return;
    const cjk = (p.text.match(/[\u4e00-\u9fff]/g) || []).length;
    (cjk >= 2 ? cn : enRaw).push(p.text);
  });

  /* 兜底归并：模型偶发把英文段按空行多拆一倍。
   * 中英段落按顺序一一对应 —— 当英文段数是中文的整数倍时，按序均匀合并回对应段。 */
  let en = enRaw;
  if (cn.length > 0 && enRaw.length > cn.length && enRaw.length % cn.length === 0) {
    const k = enRaw.length / cn.length;
    en = [];
    for (let i = 0; i < cn.length; i++) {
      en.push(enRaw.slice(i * k, (i + 1) * k).join(' '));
    }
  }
  return { en, cn, enNote, cnNote };
}

/* 解读文字（中英双语）：英文组在上、中文组在下，从光圈位置浮出 +
 * 一次涟漪扩散 + 段落逐段浮现；浮现完成后光圈淡出隐去（问题 2）。 */
function playAiRipple() {
  const rip = elNew('span', 'ai-ripple');
  el.readingView.appendChild(rip);
  void rip.offsetWidth;
  rip.classList.add('is-on');
  window.setTimeout(() => rip.remove(), 2800);
}

function showAiText(text) {
  /* 整篇浮现（不再有流式增量）：完整解读一次到位。
   * 入场做「浮出水面」——先整体不可见 + 轻微缩放/模糊，再整篇淡出成形。 */
  const r = splitReading(text);
  const en = r.en;
  const cn = r.cn;
  el.aiText.textContent = '';
  const gEn = elNew('div', 'ai-group ai-group-en');
  const gCn = elNew('div', 'ai-group ai-group-cn');
  en.forEach((t) => gEn.appendChild(elNew('p', 'ai-en', t)));
  cn.forEach((t) => gCn.appendChild(elNew('p', null, t)));
  // 免责声明前端兜底：模型偶发漏写时自动补上（extract 到了就用模型的，保证不重复）
  gEn.appendChild(elNew('p', 'ai-note ai-note-en', r.enNote || NOTE_EN));
  gCn.appendChild(elNew('p', 'ai-note', r.cnNote || NOTE_CN));
  if (gEn.childElementCount) el.aiText.appendChild(gEn);
  if (gCn.childElementCount) el.aiText.appendChild(gCn);
  el.aiText.scrollTop = 0;

  const gsap = window.gsap;

  if (REDUCED || !gsap) {
    el.aiText.classList.add('is-on');
    setAiRingVisible(false);
    return;
  }

  /* 整篇浮现（"像浮出水面"）：文字入场前完全隐去，再整篇一起出水成形 ——
   * 不做逐段 stagger（那会变成挤牙膏），而是「整体」一次到位。
   *
   * 分两层动画：
   *   ① 整体上浮 + 清模糊 + 淡入（浮出水面的主体动作）
   *   ② 竖直方向的高频低幅振荡（幅度衰减到 0）= "水面抖动"，
   *      模拟破水瞬间那一下晃动。
   * 抖动只动 .ai-text 的 transform，不碰内部文字排版，故不会触发重排。 */
  gsap.set(el.aiText, { opacity: 0, y: 26, filter: 'blur(9px)' });
  el.aiText.classList.add('is-on');           // 打开滚动区显隐与定位（此时仍全透明）

  gsap.to(el.aiText, {
    opacity: 1, y: 0, filter: 'blur(0px)',
    duration: 1.25, ease: 'power3.out',
    onComplete: () => { gsap.set(el.aiText, { clearProps: 'filter' }); },
  });

  /* 水面抖动：与上浮并行，0.09s 一跳、幅度 10→0 递减 */
  gsap.to(el.aiText, {
    keyframes: [
      { y: 10, duration: 0.09 }, { y: -7, duration: 0.09 },
      { y: 5, duration: 0.09 }, { y: -3, duration: 0.09 },
      { y: 2, duration: 0.09 }, { y: 0, duration: 0.12 },
    ],
    duration: 0.57, delay: 0.06, ease: 'none',
    onComplete: () => { gsap.set(el.aiText, { clearProps: 'transform' }); },
  });

  /* 英文组 / 中文组各自从模糊里成形（几乎同时，只留极小的先后） */
  Array.prototype.slice.call(el.aiText.children).forEach((g, i) => {
    gsap.fromTo(g,
      { opacity: 0, filter: 'blur(7px)' },
      { opacity: 1, filter: 'blur(0px)', duration: 1.05, delay: 0.1 + i * 0.08, ease: 'power2.out' });
  });

  playAiRipple();
  window.setTimeout(() => {
    if (!aiBusy) setAiRingVisible(false);   // 期间若重新发起解读，不抢状态
  }, 2200);
}

function showAiError(msg) {
  el.aiText.textContent = '';
  el.aiText.appendChild(elNew('p', 'ai-error', msg));
  el.aiText.classList.add('is-on');
  setAiRingVisible(true);   // 出错时光圈留在原地，作为重试入口
}

async function askAi() {
  /* 缓存：同一次抽牌已有解读（或正在生成）就不再调用 */
  if (aiBusy || !lastReading || lastAiText) return;
  aiBusy = true;
  setAiRingVisible(true);
  setAiThinking(true);              // 光圈进入"解读中"：黄环 + 弯曲线交错流动承担整个等待期

  /* 等待期：文字区完全空着（只看到光球特效 + 一行极淡的 Reading the cards…）。
   * 不再流式吐字 —— 用户明确要求「与其看半截字，不如多等一下」。
   * 完整解读回来后才整篇浮现（showAiText 的 non-streaming 分支）。 */
  el.aiText.textContent = '';
  el.aiText.appendChild(elNew('p', 'ai-note ai-waiting', 'Reading the cards…'));
  el.aiText.classList.add('is-on');

  const payload = {
    question: lastQuestion,
    cards: lastReading.map((c) => {
      const meta = TAROT_BY_ID[c.id];
      const mean = TAROT_MEANINGS[c.id];
      const rev = !!c.reversed;
      const en = (typeof TAROT_MEANINGS_EN !== 'undefined' && TAROT_MEANINGS_EN[c.id]) || null;
      return {
        name: meta.name,                                    // 中文牌名（供中文段）
        position: c.position || '',
        reversed: rev,
        en: meta.en,                                        // 英文牌名
        meaning: mean ? (rev ? mean.rev : mean.up) : '',    // 中文牌义
        keywords: mean ? (rev ? mean.revKeys : mean.upKeys) : [],
        meaningEn: en ? (rev ? en.rev : en.up) : '',        // 英文牌义
        keywordsEn: en ? (rev ? en.revKeys : en.upKeys) : [],
      };
    }),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);   // 双语生成更长，与 Function 预算(40s)配套

  try {
    const res = await fetch('/api/tarot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || !data.success || !data.reading) {
      showAiError((data && data.error) || 'The reading is unavailable right now. Please try again later.');
      return;
    }
    lastAiText = data.reading;
    showAiText(lastAiText);                  // 整篇浮现（含水面抖动）
    persistReading(fromHistory);
  } catch (e) {
    if (e && e.name === 'AbortError') showAiError('The reading timed out. The model is busy — please try again shortly.');
    else showAiError('Network trouble — the reading service could not be reached. Please check your connection and retry.');
  } finally {
    clearTimeout(timer);
    aiBusy = false;
    setAiThinking(false);
  }
}

/* 解读落库 + 历史回看里的重新解读同步更新该条 */
function persistReading(fromHistory) {
  if (!fromHistory || currentAt == null) return;
  let updated = null;
  records = records.map((r) => (r.at === currentAt ? (updated = Object.assign({}, r, { reading: lastAiText })) : r));
  writeOrbs(records);
  if (updated) cloudPush(updated);
}

/* ============================================================
 * 阶段 4：长按返回光球 → 炸成星光 + 生成新记录 + 回到开场
 * ============================================================ */

function startHold(e) {
  if (state !== S.READING || holdTimer) return;
  try { el.returnOrb.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  el.returnOrb.classList.add('is-holding');
  holdTimer = window.setTimeout(() => {
    holdTimer = null;
    el.returnOrb.classList.remove('is-holding');
    /* 触觉反馈：长按完成瞬间轻微震动（不支持则静默跳过） */
    try { if (navigator.vibrate) navigator.vibrate(18); } catch (err) { /* 忽略 */ }
    finishAndReturn();
  }, HOLD_MS);
}

function cancelHold() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  if (el.returnOrb) el.returnOrb.classList.remove('is-holding');
}

async function finishAndReturn() {
  if (state === S.ENDING) return;
  state = S.ENDING;

  const gsap = window.gsap;
  const orbRect = el.returnOrb.getBoundingClientRect();
  const orbCenter = { x: orbRect.left + orbRect.width / 2, y: orbRect.top + orbRect.height / 2 };

  // 三张牌 + 解读文字的矩形 → 星点汇聚到光球
  const rects = [];
  for (let i = 0; i < 3; i++) {
    if (scene && scene.ok) {
      const r = scene.cardRect(i);
      if (r) rects.push(r);
    } else if (el.hits[i]) {
      rects.push(el.hits[i].getBoundingClientRect());
    }
  }
  const textRect = el.aiText.getBoundingClientRect();
  if (textRect.height > 1) rects.push(textRect);

  // 文字与光圈先隐去
  if (gsap && !REDUCED) {
    gsap.to([el.aiText, el.aiRing], { opacity: 0, duration: 0.5, ease: 'power2.in' });
  } else {
    el.aiText.style.opacity = '0';
    el.aiRing.style.opacity = '0';
  }
  updateHits();

  await gatherTo(rects, orbCenter, 9);
  if (scene && scene.ok) scene.fadeReading(true);

  // 返回光球飞向屏幕顶部，飞上去后淡出
  if (gsap && !REDUCED) {
    const r2 = el.returnOrb.getBoundingClientRect();
    el.returnOrb.classList.add('is-flying');
    await new Promise((res) => {
      gsap.timeline({ onComplete: res })
        .to(el.returnOrb, {
          x: (window.innerWidth / 2 - (r2.left + r2.width / 2)),
          y: 22 - r2.top,
          scale: 0.62,
          duration: 1.0,
          ease: 'power2.inOut',
        })
        .to(el.returnOrb, { opacity: 0, duration: 0.45, ease: 'power2.out' });
    });
  }
  el.returnOrb.classList.remove('is-flying', 'is-on');
  el.returnOrb.style.cssText = '';
  el.aiText.style.opacity = '';
  el.aiRing.style.opacity = '';

  // 只有"新抽的一次"才写记录；历史回看不重复写入
  if (!fromHistory && lastReading) {
    const rec = {
      at: Date.now(),
      question: lastQuestion,
      cards: lastReading.map((c) => ({ id: c.id, position: c.position, reversed: !!c.reversed })),
      reading: lastAiText || '',
    };
    records = records.concat([rec]).slice(-ORB_MAX);
    writeOrbs(records);
    cloudPush(rec);                  // 新抽 → 云端写入
    await resetOpening({ animateNew: true });
  } else {
    await resetOpening({ animateNew: false });
  }
  fromHistory = false;
  currentAt = null;
}

/* 回到开场 */
async function resetOpening(opts) {
  const o = opts || {};

  if (scene && scene.ok) scene.resetReading();
  clearAiText();
  setAiRingVisible(true);
  setAiThinking(false);
  el.readingView.classList.remove('is-on');
  el.returnOrb.classList.remove('is-on');
  hideMeaning();
  showSink(false);
  if (el.wheelLabel) el.wheelLabel.classList.remove('is-on');

  cardsFlipped = [false, false, false];
  zoomIndex = -1;
  wheelLabelIndex = -1;
  for (let i = 0; i < 3; i++) setHitFace(i, false);
  updateHits();

  // 输入框归零并解锁
  el.question.value = '';
  setInputLocked(false);
  setInputFocused(false);
  resetKeyboardState();          // 回到开场：清暗淡 + 清键盘态残留（防返回后压层）
  syncRing();

  // 问句 / 输入 / 提示 / 光圈：状态 1 不出现，直接隐藏
  setAskVisible(false, true);

  // 标题重现
  showTitle(true);

  // 单张牌背重新出现（居中，不是抬升 —— 与首次进入完全一致）
  deckShown = true;
  openingOpened = false;
  if (scene && scene.ok) await scene.openingShowDeck();

  // 光球队列：新光球从右侧挤入，已有光球被挤动
  renderOrbs(records, { animateNew: !!o.animateNew, fadeIn: false });
  setOrbsVisible(true);            // 回到首页：光球重新出现

  state = S.OPENING;
}

/* ============================================================
 * 阶段 5：点顶部光球 → 历史回看
 * ============================================================ */

async function restoreRecord(rec) {
  if (state !== S.OPENING && state !== S.ASK) return;
  if (!rec || !rec.cards || rec.cards.length !== 3) return;

  state = S.DEAL;          // 过渡态：动画期间挡住重复触发
  fromHistory = true;
  currentAt = rec.at;
  lastReading = rec.cards.map((c) => ({ id: c.id, reversed: !!c.reversed, position: c.position || '' }));
  lastQuestion = rec.question || '';
  lastAiText = rec.reading || '';
  cardsFlipped = [true, true, true];
  zoomIndex = -1;

  // 问题界面必须完全隐藏（不能与滚筒重叠）
  setAskVisible(false, true);
  showTitle(false);
  hideMeaning();
  showSink(false);
  el.question.value = lastQuestion;
  setInputLocked(true);
  setInputFocused(false);
  resetKeyboardState();          // 历史回看：聚焦态与键盘态复位
  setOrbsVisible(false);          // 历史回看：光球隐藏
  syncRing();

  deckShown = false;
  if (el.deckHit) el.deckHit.hidden = true;

  wheel.a = 0;
  if (wheel.tween) { wheel.tween.kill(); wheel.tween = null; }
  if (scene && scene.ok) scene.wheelApply(wheel.a);

  const sequence = (async () => {
    // 单张牌快速展开 → 旋转 → 淡出；同时那次的三张牌飞到滚筒槽位（已按记录翻开）
    const vanishP = (scene && scene.ok) ? scene.openingVanish() : Promise.resolve();
    if (scene && scene.ok) {
      await scene.dealFromFan(lastReading.map((c) => ({
        src: cardSrc(TAROT_BY_ID[c.id].file),
        reversed: !!c.reversed,
      })), { fromDeck: true, quick: true });
      for (let i = 0; i < 3; i++) scene.presetFlipped(i);
    } else {
      for (let i = 0; i < 3; i++) setHitFace(i, true);
    }
    await vanishP;
  })();

  try {
    await Promise.race([sequence, dealTimeout(7000)]);
  } catch (e) {
    console.warn('[restoreRecord] 回看动画未按时完成，强制进入看牌：', e && e.message);
    setOrbsVisible(false);
  } finally {
    // 直接进入滚筒（先看牌）；下滑才看那次的解读；绝不永久卡在 DEAL
    if (state === S.DEAL) { state = S.ROW; updateHits(); }
  }
}

/* ============================================================
 * 点击区对齐（3D 模式按投影；无 3D 模式用固定排布）
 * ============================================================ */

/* 无 3D 时的滚筒（横向）：用与 3D 相同的公式算屏幕矩形，图片按当前朝向显示 */
function layoutFallbackWheel() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cardH = Math.min(h * 0.45, w * 1.62);
  const ratio = 0.5625;
  const R = Math.min(w * 0.58, h * 0.72);
  const cy = h * 0.445;
  for (let i = 0; i < 3; i++) {
    const n = el.hits[i];
    if (!n) continue;
    let d = (i * WHEEL_STEP - wheel.a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    const s = Math.sin(d);
    const c = Math.cos(d);
    const scale = 0.66 + (1 - 0.66) * Math.max(0, c);
    const cw = cardH * ratio * scale;
    const ch = cardH * scale;
    const x = w / 2 + R * s;
    const y = cy + R * 0.10 * Math.abs(s);
    n.hidden = false;
    n.style.left = (x - cw / 2) + 'px';
    n.style.top = (y - ch / 2) + 'px';
    n.style.width = cw + 'px';
    n.style.height = ch + 'px';
    n.style.zIndex = String(10 + Math.round(Math.max(0, c) * 10));
    n.style.opacity = String(0.78 + 0.22 * Math.max(0, c));
  }
}

function setHitFace(i, flipped) {
  const n = el.hits[i];
  if (!n) return;
  const img = n.querySelector('img');
  if (!img || !lastReading || !lastReading[i]) return;
  const meta = TAROT_BY_ID[lastReading[i].id];
  if (meta) img.src = flipped ? cardSrc(meta.file) : backSrc();
}

function updateHits() {
  const wheelView = state === S.ROW;
  const zoomView = state === S.ZOOM;
  const inReading = state === S.READING;   // 解读视图：顶部三张牌可点击返回
  for (let i = 0; i < 3; i++) {
    const n = el.hits[i];
    if (!n) continue;
    if (wheelView || (inReading && lastReading)) {
      setRect(n, scene && scene.ok
        ? scene.cardRect(i)
        : (inReading ? fallbackTopRect(i) : null));
      if (scene && scene.ok) {
        if (inReading) {
          n.style.zIndex = '30';           // 解读视图整体 z-index 5，命中区必须压在其上
        } else {
          // 越靠前的牌点击区越在上层
          n.style.zIndex = String(10 + Math.round(Math.max(0, wheelFocusCos(i)) * 10));
        }
      } else if (inReading) {
        n.style.zIndex = '30';
      }
    } else if (zoomView && zoomIndex === i) {
      setRect(n, scene && scene.ok ? scene.cardRect(i) : null);
      n.style.zIndex = '30';
    } else if (n.hidden === false) {
      n.hidden = true;
    }
  }
}

/* 无 3D 时解读视图的顶部三张牌矩形（与 computeTopSlots 同参数的屏幕版） */
function fallbackTopRect(i) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ch = Math.min(h * 0.17, w * 0.30 * (1 / 0.5625) * 0.5625);
  const cw = ch * 0.5625;
  const spread = Math.min(cw * 1.24, w * 0.30);
  const cx = w / 2 + (i - 1) * spread;
  const cy = h * 0.135;
  return { x: cx - cw / 2, y: cy - ch / 2, w: cw, h: ch };
}

/* 居中标签：某张牌转到中央（对齐度足够高）时淡入并显示身份 */
let wheelLabelIndex = -1;

function tickWheelUi() {
  /* 三角形只在滚筒态出现（放大 / 解读 / 其他状态隐藏） */
  const navOn = state === S.ROW;
  if (el.navPrev) el.navPrev.classList.toggle('is-on', navOn);
  if (el.navNext) el.navNext.classList.toggle('is-on', navOn);

  if (!el.wheelLabel) return;
  if (state !== S.ROW || !lastReading) {
    el.wheelLabel.classList.remove('is-on');
    return;
  }
  const i = wheelFocusedIndex();
  if (i !== wheelLabelIndex) {
    wheelLabelIndex = i;
    el.wheelLabel.textContent = POSITIONS[i];
  }
  el.wheelLabel.classList.toggle('is-on', wheelFocusCos(i) > 0.9);
}

function tickOverlay() {
  requestAnimationFrame(tickOverlay);
  if (!el.deckHit) return;

  if (scene && scene.ok) {
    if (state === S.ROW || state === S.ZOOM) scene.wheelApply(wheel.a);
    setRect(el.deckHit, deckShown ? scene.openingDeckRect() : null);
    updateHits();
    tickWheelUi();
  } else {
    // 无 3D：牌背用图片顶替
    setRect(el.deckHit, deckShown
      ? { x: window.innerWidth / 2 - 106, y: window.innerHeight / 2 - 189, w: 212, h: 378 }
      : null);
    const r0 = el.hits[0];
    if (r0 && (state === S.ROW || state === S.ZOOM)) layoutFallbackWheel();
    tickWheelUi();
  }
}

/* ============================================================
 * 输入区自适应：固定三行高；三行内正常字号；超出逐步缩字号；
 * 缩到下限仍放不下 → 允许滚动。文字始终居中（水平 CSS，垂直动态补白）。
 * ============================================================ */

const Q_FONT_MAX = 22;
const Q_FONT_MIN = 13.5;
const Q_FONT_STEP = 0.5;
const Q_LINES = 3;
const Q_LINE_RATIO = 1.5;

/* 按当前字号把输入框高度精确设为三行（字号随 vw clamp，resize 后需重算） */
function setupQuestionBox() {
  const ta = el.question;
  if (!ta) return;
  const fs = parseFloat(getComputedStyle(ta).fontSize) || Q_FONT_MAX;
  ta.style.height = Math.round(fs * Q_LINE_RATIO * Q_LINES) + 'px';
  fitQuestion();
}

function fitQuestion() {
  const ta = el.question;
  if (!ta) return;
  const boxH = ta.clientHeight;
  const fits = () => ta.scrollHeight <= boxH + 1;
  let fs = parseFloat(getComputedStyle(ta).fontSize) || Q_FONT_MAX;
  ta.style.fontSize = fs.toFixed(1) + 'px';

  /* 垂直居中：清掉上下补白量内容行数，再把剩余空间对称补回 */
  const center = () => {
    ta.style.paddingTop = '0px';
    ta.style.paddingBottom = '0px';
    const lh = fs * Q_LINE_RATIO;
    const hasText = (ta.value || '').trim().length > 0;
    /* 空框按 1 行居中（scrollHeight≈盒高会被误算成 3 行）；有字再按实际内容行数 */
    const lines = hasText ? Math.max(1, Math.round(ta.scrollHeight / lh)) : 1;
    const pad = Math.max(0, (boxH - lines * lh) / 2);
    ta.style.paddingTop = pad.toFixed(1) + 'px';
    ta.style.paddingBottom = pad.toFixed(1) + 'px';
    return lines;
  };
  center();
  let guard = 0;
  while (!fits() && fs > Q_FONT_MIN && guard < 24) {
    fs = Math.max(Q_FONT_MIN, fs - Q_FONT_STEP);
    ta.style.fontSize = fs.toFixed(1) + 'px';
    center();
    guard++;
  }
  if (fits()) {
    ta.style.overflowY = 'hidden';
    ta.scrollTop = 0;
  } else {
    /* 最小字号仍放不下：允许滚动，补白收到最小，首行与末行都留呼吸 */
    ta.style.overflowY = 'auto';
    ta.style.paddingTop = '3px';
    ta.style.paddingBottom = '3px';
  }
}

/* ============================================================
 * 视口锁定 + 键盘自适应（visualViewport）
 * 主布局与 3D 画布的高度锁定在「无键盘视口高」（--vph），
 * 键盘弹出（宽不变、高骤缩）不触发 resize，只上浮输入区。
 * ============================================================ */

const KB_MIN = 90;            // 高度缩水超过该值视为键盘弹出
const KB_LIFT_MARGIN = 24;    // 输入区底边与键盘顶边的间距
let vpLock = { w: window.innerWidth, h: window.innerHeight };
let kbOn = false;
let inputFocused = false;     // 统一焦点状态：true → 非输入元素暗淡，输入区+流光上浮

function lockViewport() {
  vpLock = { w: window.innerWidth, h: window.innerHeight };
  document.documentElement.style.setProperty('--vph', vpLock.h + 'px');
}

/* 统一焦点状态：输入框聚焦 → 非输入元素暗淡（由 CSS body.input-focused 驱动）；
 * 失焦 / 页面切换 → 复位。true→true / false→false 直接短路，反复点击不触发重复变化。 */
function setInputFocused(v) {
  v = !!v;
  if (inputFocused === v) return;
  inputFocused = v;
  document.body.classList.toggle('input-focused', v);
}

/* 键盘态复位：离开提问环节 / 返回开场 / 历史回看时必须调用。
 * 若不复位，输入框会带着 fixed 定位与内联 left/width/bottom 残留，
 * 返回后压在上层（用户反馈的"文字返回以后和背后元素重叠"）。 */
let fieldHome = null;        // 输入框在聚簇里的原位置（下一个兄弟节点），搬家后凭它放回
let fieldMoving = false;     // 搬家进行中：期间触发的 blur 不是真失焦，不据此复位键盘态

function resetKeyboardState() {
  kbOn = false;
  document.body.classList.remove('kb-open');
  restoreField();                    // 搬回聚簇原位（清内联定位也在这一步做）
  document.documentElement.style.setProperty('--kb', '0px');
}

/* 键盘自适应：输入框在键盘态下「脱离 flex 流」——由 body.kb-open + 内联
 * left/width/top 直接钉到键盘上方，问句 / 提示 / 光圈全程不动。
 *
 * 坐标口径：fixed 的 top/left 是「相对视觉视口」的像素值。键盘顶边在视觉
 * 视口里的位置就是 vv.height，所以输入框底边贴 KB_LIFT_MARGIN 上方即：
 *     top = vv.height - KB_LIFT_MARGIN - fieldH
 * 再夹一层安全上限，避免多行时越过屏幕顶端。
 *
 * ⚠️ 关键：CSS 里祖先带 transform 会成为 fixed 后代的「包含块」——
 * .ask-cluster 有 translateX(-50%)，会把 fixed 的参照系从视口换成聚簇自身，
 * 导致 top/left 全部错位。因此键盘态必须把输入框移到 body 下（见 liftFieldOut），
 * 收起时再放回聚簇原位（见 restoreField）。 */
const KB_TOP_SAFE = 92;      // 输入框顶边与屏幕顶的最小间距（避开顶部光球/标题）
function liftFieldOut() {
  const field = el.openingField;
  if (!field || field.dataset.lifted === '1') return;
  if (!fieldHome) fieldHome = field.nextSibling;
  const wasFocused = document.activeElement === el.question || document.activeElement === field;
  /* 搬家会让聚焦元素失焦（DOM 移动的既有行为）→ 触发一次假 blur，用 flag 挡住。
   *
   * ⚠️ 搬完**必须无条件把焦点还给 input**（前提：搬之前焦点在输入区里）。
   * 曾经的写法是「仅当 activeElement !== el.question 才 refocus」——这个判断是错的：
   * 点输入框时 activeElement 本来**就是** el.question，条件恒为 false，永远不 refocus。
   * 结果：焦点掉到 body 上 → 用户按键盘自带的「收起」键时 input 早就不在焦点，
   * 不会触发 blur → 表现为「点键盘回收键无法收起，只能点键盘外面」
   * （点键盘外面之所以有效，是因为兜底的 pointerdown 出口不看焦点）。
   *
   * 还焦点必须严格限定在「搬之前焦点就在输入区」的情况；
   * 若是别的原因走进来（理论上不该有），抢焦点会造成关不掉的循环。 */
  fieldMoving = true;
  field.dataset.lifted = '1';
  document.body.appendChild(field);         // 脱离 transform 祖先 → fixed 参照系回到视口
  if (wasFocused && el.question) {
    try { el.question.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
  }
  /* fieldMoving 用宏任务复位：blur 是同步派发的，等焦点还回去并稳定后再放开 */
  window.setTimeout(() => { fieldMoving = false; }, 0);
}

function restoreField() {
  const field = el.openingField;
  if (!field || field.dataset.lifted !== '1') return;
  const wasFocused = document.activeElement === el.question;
  fieldMoving = true;                        // 搬回同样会造成一次假 blur，挡住
  delete field.dataset.lifted;
  const cluster = document.querySelector('.ask-cluster');
  if (cluster) cluster.insertBefore(field, fieldHome && fieldHome.parentNode === cluster ? fieldHome : null);
  else if (fieldHome && fieldHome.parentNode) fieldHome.parentNode.insertBefore(field, fieldHome);
  fieldHome = null;
  field.style.left = '';
  field.style.width = '';
  field.style.top = '';
  /* 只在「收起前确实还在输入」时还焦点；若收起本来就是失焦引起的（用户点了别处），
   * 绝不能抢回焦点，否则点空白处会变成关不掉的循环。 */
  if (wasFocused && el.question) { try { el.question.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }
  window.setTimeout(() => { fieldMoving = false; }, 0);
}

function handleKeyboard() {
  const vv = window.visualViewport;
  const viewH = vv ? vv.height : window.innerHeight;      // 视觉视口可视高
  const kb = Math.max(0, vpLock.h - viewH - (vv ? vv.offsetTop : 0));
  const on = kb > KB_MIN;
  kbOn = on;

  const field = el.openingField;
  /* 键盘态开关：CSS 靠 body.kb-open 把 .opening-field 切成 fixed */
  document.body.classList.toggle('kb-open', on);

  if (!on || !field) {
    document.documentElement.style.setProperty('--kb', '0px');
    restoreField();
    return;
  }

  liftFieldOut();

  /* 水平位置：与开场聚簇等宽居中（fixed 后不再继承 flex 的居中）。
   * 搬家后先量一次宽度 —— 脱离 flex 后 width:100% 会变成 body 宽，必须显式钉住。 */
  const restW = Math.min(vpLock.w * 0.8, 520);
  const restLeft = Math.max(0, (vpLock.w - restW) / 2);
  field.style.width = Math.round(restW) + 'px';
  field.style.left = Math.round(restLeft) + 'px';

  const fieldH = field.offsetHeight || 78;
  let top = viewH - KB_LIFT_MARGIN - fieldH;               // 底边贴键盘上方
  if (top < KB_TOP_SAFE) top = KB_TOP_SAFE;                // 多行时不许越出屏幕顶
  field.style.top = Math.round(top) + 'px';

  document.documentElement.style.setProperty('--kb', '0px');   // fixed 态不再用 --kb 位移
  try { window.scrollTo(0, 0); } catch (e) { /* 忽略 */ }
}

/* 视口变化分三类，处理方式完全不同：
 *
 * 1) 键盘弹出：宽不变、高骤缩（> KB_MIN）。主布局**不许动**（--vph 保持锁定），
 *    只上浮输入区 —— 否则画布与牌会跟着挤压。
 * 2) 地址栏伸 / 缩：宽不变、高小幅变化（< KB_MIN）。这是**真 resize**，
 *    必须重锁 --vph，否则文档高固定为「打开页面时的最大高」，
 *    只要真机视口掉到锁定值以下（iOS 地址栏展开 / 底部手势条遮挡），
 *    文档就比视口高 → 右侧竖直滚动条闪现（用户报的"页面大小在抽搐"）。
 * 3) 旋转 / 分屏：宽变了 → 重锁 + 重算布局 + 3D 重排。
 *
 * 判定「是否键盘」不能只看高度差：键盘弹出时焦点必在输入框上，
 * 地址栏伸缩时通常没有输入焦点。用 focus 状态做二次确认，避免把
 * 小幅地址栏变化误判成键盘（那会导致 --vph 永不更新 → 滚动条抖动）。 */
function onViewportChange() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const widthSame = Math.abs(w - vpLock.w) <= 2;
  /* 键盘：高度骤缩 + 输入框处于焦点态（keyboard 弹起必然伴随 focus） */
  const likelyKeyboard = widthSame && h < vpLock.h - KB_MIN && (inputFocused || kbOn);

  if (likelyKeyboard) {
    handleKeyboard();
    return;
  }

  lockViewport();
  handleKeyboard();
  setupQuestionBox();
  if (scene && scene.ok) scene.resize();
}

function setupViewport() {
  lockViewport();
  handleKeyboard();
  setupQuestionBox();

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 240));

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', onViewportChange);
    /* iOS 聚焦输入框时会把视觉视口滚到输入框处 —— 键盘开着时强制回顶 */
    vv.addEventListener('scroll', () => { if (kbOn) window.scrollTo(0, 0); });
  }
  /* 焦点状态统一驱动暗淡：聚焦 → 非输入元素暗淡；失焦 → 复原。
   * 键盘弹出时的上浮由 handleKeyboard 处理，这里只管焦点状态。 */
  if (el.question) {
    el.question.addEventListener('focus', () => {
      try { window.scrollTo(0, 0); } catch (e) { /* 忽略 */ }
      setInputFocused(true);
    });
    el.question.addEventListener('blur', () => {
      if (fieldMoving) return;     // 键盘态搬家导致的假 blur：不是真失焦，别复位
      setInputFocused(false);
      resetKeyboardState();        // 失焦 = 键盘收起：同步清掉键盘态定位
    });
  }

  /* 收起键盘的兜底出口。
   * 为什么必须有：键盘态下输入框被搬到了 body 下，聚焦可能已不在它身上
   * （DOM 移动的副作用），此时 blur 不会再触发 —— 若只靠 blur 收起，
   * 用户体验就是「输入框点开后关不掉」。因此额外提供两个明确出口：
   *   ① 按住输入框以外的任何位置（pointerdown 在输入框外）→ 失焦收起
   *   ② Escape 键 → 失焦收起
   * 两者都只在键盘态/聚焦态下生效，不干扰其他交互。
   *
   * ⚠️ 不能只调 el.question.blur()：若焦点已不在 input 上（搬家副作用残留），
   * blur() 是空操作，键盘收不掉。所以「先无条件复位 UI 状态」，
   * blur() 只作为额外保险（触发浏览器原生收键盘）。 */
  const blurIfTyping = () => {
    if (!kbOn && !inputFocused) return;
    if (el.question) { try { el.question.blur(); } catch (e) { /* 忽略 */ } }
    setInputFocused(false);
    resetKeyboardState();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!kbOn && !inputFocused) return;
    if (el.openingField && el.openingField.contains(e.target)) return;   // 点输入区自身：不收起
    blurIfTyping();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') blurIfTyping();
  });

  /* 「键盘回收」出口：软键盘自带的收起键 / 系统返回键收起键盘时，
   * 视觉视口会恢复高度 —— 这是唯一的可靠信号。
   *
   * 为什么不能只信 blur：真机上输入框被搬到 body 下后，某些输入法收起键盘时
   * input 保持焦点、**不发 blur**，只把 visualViewport 恢复。此时若只监听 blur，
   * 键盘态（fixed 定位 + body.kb-open）就永远残留 —— 用户报的
   * 「点键盘回收键无法收起，只能点键盘外面」正是此形态。
   *
   * ⚠️ 定时器必须**常驻**，不能自我清理：早期写法是「kbOn 为 false 就 clearInterval」，
   * 但本函数在页面加载时即启动，那时 kbOn 恒为 false → 定时器第一轮就自杀，
   * 之后再不会运行（这就是兜底失效的原因）。正确做法是常驻轮询、
   * 内部只在 kbOn 为真时才判视口，开销可忽略（220ms 一次的两个属性读取）。 */
  window.setInterval(() => {
    if (!kbOn) return;                       // 非键盘态：什么都不做，但定时器继续活着
    const vv2 = window.visualViewport;
    const viewH = vv2 ? vv2.height : window.innerHeight;
    const kbNow = Math.max(0, vpLock.h - viewH - (vv2 ? vv2.offsetTop : 0));
    if (kbNow <= KB_MIN) {
      /* 视口已恢复但状态仍标记键盘开着 → 键盘真的收了，强制复位 */
      setInputFocused(false);
      resetKeyboardState();
    }
  }, 220);
}

/* ============================================================
 * 初始化
 * ============================================================ */

function cacheDom() {
  el.gl = document.getElementById('gl');
  el.glNotice = document.getElementById('glNotice');
  el.burstLayer = document.getElementById('burstLayer');
  el.deckHit = document.getElementById('deckHit');
  el.hits = [document.getElementById('hit0'), document.getElementById('hit1'), document.getElementById('hit2')];

  el.opening = document.getElementById('opening');
  el.orbRow = document.getElementById('orbRow');
  el.orbDeleteArc = document.getElementById('orbDeleteArc');
  orbFxLoop();              /* 首页光球呼吸涟漪 & 删除弧提示（仅 OPENING 态随机触发） */
  el.openingTitle = document.getElementById('openingTitle');
  el.openingQuestion = document.getElementById('openingQuestion');
  el.openingField = document.querySelector('.opening-field');
  el.openingHint = document.querySelector('.opening-hint');
  el.ringBtn = document.getElementById('ringBtn');
  el.question = document.getElementById('question');
  el.drawHint = document.getElementById('drawHint');

  el.cardRead = document.getElementById('cardRead');
  el.zoomLabel = document.getElementById('zoomLabel');
  el.navPrev = document.getElementById('wheelPrev');
  el.navNext = document.getElementById('wheelNext');
  el.readName = document.getElementById('readName');
  el.readBadge = document.getElementById('readBadge');
  el.readKeys = document.getElementById('readKeys');
  el.readText = document.getElementById('readText');

  el.sinkZone = document.getElementById('sinkZone');
  el.sinkRing = document.getElementById('sinkRing');
  el.wheelLabel = document.getElementById('wheelLabel');
  el.readingView = document.getElementById('readingView');
  el.aiRing = document.getElementById('aiRing');
  el.aiText = document.getElementById('aiText');
  el.returnOrb = document.getElementById('returnOrb');
}

function init() {
  cacheDom();

  // 清掉更早版本遗留的本地数据（旧的历史列表 UI 已移除）
  try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* 忽略 */ }

  const dataOk = typeof TAROT_CARDS !== 'undefined' && TAROT_CARDS.length === 78;
  if (!dataOk && el.drawHint) el.drawHint.textContent = 'Card data failed to load. Please refresh.';

  /* ---- 3D 场景 ---- */
  scene = createTarotScene(el.gl);
  if (!scene.ok) {
    document.body.classList.add('no-3d');
    if (el.glNotice) {
      el.glNotice.hidden = false;
      el.glNotice.querySelector('.gl-notice-title').textContent =
        scene.reason === 'no-webgl' ? '你的浏览器暂不支持 3D 渲染' : '3D 场景未能启动';
      el.glNotice.querySelector('.gl-notice-text').textContent = '已切换为简洁模式：功能完全正常。';
    }
    if (el.deckHit) el.deckHit.hidden = false;
  } else {
    scene.openingShowDeck();
    /* 空闲后台预热全部牌面（webp 约 54KB/张），抽牌时命中缓存即秒出 */
    if (scene.preloadFaces && window.TAROT_CARDS) {
      scene.preloadFaces(window.TAROT_CARDS.map((c) => cardSrc(c.file)));
    }
    if (el.glNotice) el.glNotice.hidden = true;
  }

  /* ---- 顶部光球 ---- */
  records = readOrbs();
  renderOrbs(records);
  /* 云端同步：
   *  - D1 未配置（backend:false）→ cloudPull 返回 null → 保留本地，不动
   *  - D1 已配置 → 本地 + 云端按 at 合并（云端优先），排除本地已隐藏的 at，写回本地（最多 ORB_MAX 条）；
   *    仅本地存在、云端没有的记录补推上云（迁移绑定前历史）；云端记录永不删除。 */
  cloudPull().then((orbs) => {
    if (!orbs) return;                       // 无云端：纯本地
    /* 云端 hidden 标记合并进本地隐藏集 → 清缓存后 cloudPull 仍能据此排除，与本地解绑 */
    const hidden = loadHidden();
    orbs.forEach((r) => { if (r && r.hidden) hidden.add(String(r.at)); });
    saveHidden(hidden);
    const cloudAts = new Set(orbs.map((r) => String(r && r.at)));
    const byAt = new Map();
    records.forEach((r) => { if (r && r.at && !hidden.has(String(r.at))) byAt.set(String(r.at), r); });
    orbs.forEach((r) => { if (r && r.cards && r.cards.length === 3 && !hidden.has(String(r.at))) byAt.set(String(r.at), r); }); // 云端覆盖，排除已隐藏
    records = Array.from(byAt.values())
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(-ORB_MAX);
    writeOrbs(records);
    if (state === S.OPENING) renderOrbs(records);
    /* 把仅本地有的历史补推上云（云端不删，隐藏集内的不在此列） */
    records.forEach((r) => { if (r && r.at && !cloudAts.has(String(r.at))) cloudPush(r); });
  });

  /* ---- 事件 ---- */
  if (el.deckHit) {
    el.deckHit.addEventListener('pointerdown', onDeckPointerDown);
    el.deckHit.addEventListener('click', onDeckClick);
  }
  el.hits.forEach((n, i) => { if (n) n.addEventListener('click', () => onCardHit(i)); });
  if (el.navPrev) el.navPrev.addEventListener('click', () => wheelStepTo(-1));
  if (el.navNext) el.navNext.addEventListener('click', () => wheelStepTo(1));
  if (el.ringBtn) el.ringBtn.addEventListener('click', startDraw);
  if (el.question) {
    /* textarea：禁止换行（粘贴的多行折叠成空格），输入即同步流光/光圈与自适应 */
    el.question.addEventListener('input', () => {
      const v = el.question.value;
      if (/\r?\n/.test(v)) {
        el.question.value = v.replace(/\r?\n/g, ' ');
      }
      syncRing();
      fitQuestion();
    });
    el.question.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); startDraw(); }
    });
  }
  if (el.sinkRing) el.sinkRing.addEventListener('click', enterReading);
  if (el.aiRing) el.aiRing.addEventListener('click', askAi);
  if (el.returnOrb) {
    el.returnOrb.addEventListener('pointerdown', startHold);
    el.returnOrb.addEventListener('pointerup', cancelHold);
    el.returnOrb.addEventListener('pointercancel', cancelHold);
    el.returnOrb.addEventListener('contextmenu', (e) => e.preventDefault());   // 长按不弹菜单
  }
  if (el.orbRow) {
    const pick = (target) => {
      const orb = target && target.closest ? target.closest('.orb') : null;
      if (!orb || !orb.dataset.at) return null;
      return records.filter((r) => String(r.at) === orb.dataset.at)[0] || null;
    };
    el.orbRow.addEventListener('click', (e) => {
      if (suppressOrbClick) { suppressOrbClick = false; return; }
      const rec = pick(e.target);
      if (rec) restoreRecord(rec);
    });
    el.orbRow.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const rec = pick(e.target);
      if (!rec) return;
      e.preventDefault();
      restoreRecord(rec);
    });
    el.orbRow.addEventListener('pointerdown', onOrbPointerDown);
    /* move/up 绑在 window：拖出时光球被提到 body，事件不再冒泡到 orbRow */
    window.addEventListener('pointermove', onOrbDeleteMove);
    window.addEventListener('pointerup', onOrbDeleteUp);
    window.addEventListener('pointercancel', onOrbDeleteUp);
    el.orbRow.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ---- 视口锁定 + 键盘自适应 ----
   * 键盘弹出（宽不变、高骤缩）时：不 resize 场景、不挤布局，
   * 只把输入区 translateY 到键盘上方、其余元素淡化压暗；键盘收起复原。 */
  setupViewport();

  /* ---- 首屏 ---- */
  const gsap = window.gsap;
  if (gsap && !REDUCED && el.openingTitle) {
    gsap.from(el.openingTitle, { y: -18, opacity: 0, duration: 1.4, ease: 'power3.out', delay: 0.15 });
  }

  setAskVisible(false, true);   // 状态 1 不出现问句/输入/提示/光圈（含 visibility，防透明输入框挡点击）
  syncRing();
  tickOverlay();
  state = S.OPENING;
}

/* 只读诊断口：调参与自动化验证用，不参与任何逻辑 */
window.TarotDebug = {
  state: () => state,
  records: () => records.slice(),
  flipped: () => cardsFlipped.slice(),
  lastReading: () => lastReading,
  lastAiText: () => lastAiText,
  sceneReady: () => !!(scene && scene.ok),
  deckRect: () => (scene && scene.openingDeckRect ? scene.openingDeckRect() : null),
  cardRect: (i) => (scene && scene.cardRect ? scene.cardRect(i) : null),
  tilt: () => (scene && scene.openingTilt ? scene.openingTilt() : null),
  view: () => (scene && scene.getView ? scene.getView() : null),
  zoomed: () => (scene && scene.getZoomed ? scene.getZoomed() : -1),
  wheel: () => ({
    a: +wheel.a.toFixed(4),
    focused: wheelFocusedIndex(),
    focusCos: [0, 1, 2].map((i) => +wheelFocusCos(i).toFixed(3)),
    resting: wheelResting(),
  }),
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
