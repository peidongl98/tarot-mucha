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

/* 顶部光球：最多 3 个，从左到右 = 最旧 → 最新 */
const ORB_MAX = 3;
const ORB_KEY = 'tarot_orbs';
/* 更早版本用 localStorage 存抽牌历史列表，那套 UI 已移除；顺手清掉遗留键 */
const LEGACY_KEY = 'tarot_history';

const HOLD_MS = 1100;          // 长按返回光球的时长
const DRAG_SLOP = 12;          // 按下到抬起的位移阈值（px）：超过就算拖动，不算点击
const SWIPE_MIN = 46;          // 触发上滑 / 下滑的最小竖直位移
const SWIPE_MAX_MS = 700;      // 手势最长时间

/* 滚筒：角度由前端统一持有（3D 与降级模式共用同一套交互） */
const WHEEL_STEP = (Math.PI * 2) / 3;   // 相邻两牌的角距（120°）
const WHEEL_DRAG_RATE = 4.4;            // 拖动灵敏度：约半屏宽度转一格（120°）
const WHEEL_FLING_GAIN = 0.16;          // 惯性外推时间（秒）
const wheel = { a: 0, dragging: false, tween: null, suppressedAt: 0 };

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
let touchStart = null;
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
}

/* 问句 / 输入 / 提示 / 光圈：只在「状态 2（点牌背后）」出现。
 * 状态 1（开场）、状态 3+（抽牌后）、历史回看里都必须完全隐藏（含 visibility，
 * 否则透明输入框会挡住底下牌背的点击）。 */
function setAskVisible(on, instant) {
  const targets = [el.openingQuestion, el.openingField, el.openingHint, el.ringBtn].filter(Boolean);
  const gsap = window.gsap;
  if (on) {
    targets.forEach((n) => { n.style.visibility = ''; });
    if (!gsap || REDUCED || instant) {
      targets.forEach((n) => { n.style.opacity = '1'; n.style.transform = 'none'; });
      focusOnDesktop();
      return;
    }
    gsap.fromTo(targets,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 1.0, stagger: 0.16, ease: 'power3.out', delay: 0.8, onComplete: focusOnDesktop });
    return;
  }
  if (instant || !gsap || REDUCED) {
    targets.forEach((n) => { n.style.opacity = '0'; n.style.visibility = 'hidden'; });
    return;
  }
  return new Promise((res) => {
    gsap.to(targets, {
      opacity: 0, y: -10, duration: 0.6, stagger: 0.06, ease: 'power2.in',
      onComplete: () => { targets.forEach((n) => { n.style.visibility = 'hidden'; }); res(); },
    });
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

/* 开场光圈：空态暗且静止，有字后变亮 + 涟漪扩散 */
function syncRing() {
  if (!el.ringBtn) return;
  const has = (el.question.value || '').trim().length > 0;
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

function wheelNudge(dxPx) {
  if (wheel.tween) { wheel.tween.kill(); wheel.tween = null; }
  wheel.dragging = true;
  wheel.a -= dxPx * (WHEEL_DRAG_RATE / Math.max(1, window.innerWidth));   // 左拖 = 前进
}

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

function wheelRelease(velocityPxPerSec) {
  wheel.dragging = false;
  const rate = WHEEL_DRAG_RATE / Math.max(1, window.innerWidth);
  const proj = wheel.a - (velocityPxPerSec || 0) * WHEEL_FLING_GAIN * rate;   // 惯性与拖动同向
  wheelSnapTo(Math.round(proj / WHEEL_STEP) * WHEEL_STEP, 0.85);
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

const wheelResting = () => !wheel.dragging && !wheel.tween;

/* ---- 指针拖动（窗口级：从任何位置起拖都行；点击与拖动用位移阈值区分） ---- */
let wheelPtr = null;

function onWheelPtrDown(e) {
  if (state !== S.ROW || wheelPtr) return;
  wheelPtr = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, lastT: performance.now(), vx: 0, moved: 0 };
}

function onWheelPtrMove(e) {
  if (!wheelPtr || e.pointerId !== wheelPtr.id) return;
  const dx = e.clientX - wheelPtr.lastX;
  const dy = e.clientY - wheelPtr.lastY;
  wheelPtr.lastX = e.clientX;
  wheelPtr.lastY = e.clientY;
  wheelPtr.moved += Math.abs(dx) + Math.abs(dy);
  if (!dx) return;
  const now = performance.now();
  const dt = Math.max(8, now - wheelPtr.lastT) / 1000;
  wheelPtr.lastT = now;
  wheelPtr.vx = wheelPtr.vx * 0.7 + (dx / dt) * 0.3;   // 平滑速度，松手时用于惯性
  wheelNudge(dx);
}

function onWheelPtrUp(e) {
  if (!wheelPtr || e.pointerId !== wheelPtr.id) return;
  const v = wheelPtr.vx;
  const moved = wheelPtr.moved;
  wheelPtr = null;
  wheelRelease(moved > DRAG_SLOP ? v : 0);
  if (moved > DRAG_SLOP) wheel.suppressedAt = Date.now();   // 拖动后的误点击不当作翻牌
}

/* ============================================================
 * 阶段 1：点光圈 → 抽牌
 * ============================================================ */

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
  showStarHint(false);
  setAiRingVisible(true);
  setAiThinking(false);

  const cards = drawThree();
  lastReading = cards;

  // ① 最旧光球炸成星光消失；② 剩余光球变黯淡 + 缓慢漂浮
  const hadOrb = await burstOldestOrb();
  if (hadOrb) dimOrbs(true);

  // ③ 问句 / 输入 / 提示 / 光圈淡出
  const fade = hideAskArea();

  // ④ 扇形退场 + 三张牌飞向滚筒（背面朝上）
  if (scene && scene.ok) {
    await scene.dealFromFan(cards.map((c) => ({
      src: 'cards/' + TAROT_BY_ID[c.id].file,
      reversed: !!c.reversed,
    })));
  } else {
    layoutFallbackWheel();
  }
  await fade;

  if (el.burstLayer) el.burstLayer.style.display = 'none';
  state = S.ROW;
  updateHits();
}

/* ============================================================
 * 阶段 2：看牌（翻面 / 放大看牌义）
 * ============================================================ */

function onCardHit(i) {
  if (Date.now() - wheel.suppressedAt < 400) return;   // 拖动结束后的误触不当作点击
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
      window.setTimeout(() => { if (state === S.ROW) showStarHint(true); }, 950);
    }
  } else {
    zoomIn(i);
  }
}

function zoomIn(i) {
  if (!lastReading || !lastReading[i]) return;
  state = S.ZOOM;
  zoomIndex = i;
  showStarHint(false);
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
  if (cardsFlipped.every(Boolean)) showStarHint(true);
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

/* 底部星光引导 + 滚动提示（三张都翻开后一起出现） */
function buildStarHint() {
  if (!el.starHint || el.starHint.childElementCount) return;
  for (let i = 0; i < 15; i++) {
    const s = elNew('i');
    s.style.setProperty('--dx', ((i - 7) * 7) + 'px');
    s.style.animationDelay = (i * 0.19) + 's';
    el.starHint.appendChild(s);
  }
}

function showStarHint(on) {
  if (el.starHint) el.starHint.classList.toggle('is-on', !!on);
  if (el.scrollHint) el.scrollHint.classList.toggle('is-on', !!on);
}

/* ============================================================
 * 阶段 3：上滑 → 解读
 * ============================================================ */

function enterReading() {
  if (state !== S.ROW) return;
  state = S.READING;
  zoomIndex = -1;
  hideMeaning();
  showStarHint(false);
  if (scene && scene.ok) scene.setView('top');
  el.readingView.classList.add('is-on');
  el.returnOrb.classList.add('is-on');
  if (lastAiText) showAiText(lastAiText, true);      // 历史回看 / 已解读过：直接显示，光圈隐去
  else { clearAiText(); setAiRingVisible(true); }     // 未解读：光圈亮起等待点击
  updateHits();
}

function exitReading() {
  if (state !== S.READING) return;
  state = S.ROW;
  if (scene && scene.ok) scene.setView('row');
  el.readingView.classList.remove('is-on');
  el.returnOrb.classList.remove('is-on');
  if (cardsFlipped.every(Boolean)) showStarHint(true);
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

/* 解读分语种：先按空行分段（段内偶发的软换行合并回一段），
 * 再按语言归类 —— 含 ≥2 个 CJK 字符的段归中文，其余归英文。
 * 旧记录是纯中文，走同一路径（英文组为空 → 只显示中文）。 */
function splitReading(text) {
  const blocks = String(text)
    .split(/\r?\n\s*\r?\n/)                       // 空行 = 段落边界
    .map((b) => {
      const joined = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!joined.length) return '';
      return joined.join(' ');                      // 段内软换行以空格相连（含中英双免责相邻行）
    })
    .filter(Boolean);
  const enRaw = [];
  const cn = [];
  let enNote = '';
  let cnNote = '';
  blocks.forEach((p) => {
    if (!enNote && /for entertainment/i.test(p)) { enNote = p; return; }   // 免责先摘出，不参与正文配对
    if (!cnNote && /仅供娱乐参考/.test(p)) { cnNote = p; return; }
    const cjk = (p.match(/[\u4e00-\u9fff]/g) || []).length;
    (cjk >= 2 ? cn : enRaw).push(p);
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
function showAiText(text, instant) {
  const r = splitReading(text);
  const en = r.en;
  const cn = r.cn;
  el.aiText.textContent = '';
  const gEn = elNew('div', 'ai-group ai-group-en');
  const gCn = elNew('div', 'ai-group ai-group-cn');
  en.forEach((t) => gEn.appendChild(elNew('p', 'ai-en', t)));
  cn.forEach((t) => gCn.appendChild(elNew('p', null, t)));
  if (r.enNote) gEn.appendChild(elNew('p', 'ai-note ai-note-en', r.enNote));
  if (r.cnNote) gCn.appendChild(elNew('p', 'ai-note', r.cnNote));
  if (gEn.childElementCount) el.aiText.appendChild(gEn);
  if (gCn.childElementCount) el.aiText.appendChild(gCn);
  el.aiText.classList.add('is-on');
  el.aiText.scrollTop = 0;

  const gsap = window.gsap;
  const ps = Array.prototype.slice.call(el.aiText.querySelectorAll('p'));

  if (instant || REDUCED || !gsap || !ps.length) {
    setAiRingVisible(false);
    return;
  }
  const rip = elNew('span', 'ai-ripple');
  el.readingView.appendChild(rip);
  void rip.offsetWidth;
  rip.classList.add('is-on');
  window.setTimeout(() => rip.remove(), 2800);
  const stagger = 0.3;
  gsap.fromTo(ps,
    { opacity: 0, y: 12 },
    { opacity: 1, y: 0, duration: 0.9, stagger, ease: 'power2.out', delay: 0.2 });
  const totalMs = (0.2 + stagger * (ps.length - 1) + 0.9 + 0.4) * 1000;
  window.setTimeout(() => {
    if (!aiBusy) setAiRingVisible(false);   // 期间若重新发起解读，不抢状态
  }, totalMs);
}

function showAiError(msg) {
  el.aiText.textContent = '';
  el.aiText.appendChild(elNew('p', 'ai-error', msg));
  el.aiText.classList.add('is-on');
  setAiRingVisible(true);   // 出错时光圈留在原地，作为重试入口
}

async function askAi() {
  if (aiBusy || !lastReading) return;
  aiBusy = true;
  setAiRingVisible(true);
  setAiThinking(true);
  el.aiText.textContent = '';
  el.aiText.classList.add('is-on');
  el.aiText.appendChild(elNew('p', 'ai-note', 'Reading the cards…'));

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
    showAiText(data.reading);
    // 历史回看里重新解读 → 更新那条记录
    if (fromHistory && currentAt != null) {
      records = records.map((r) => (r.at === currentAt ? Object.assign({}, r, { reading: lastAiText }) : r));
      writeOrbs(records);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') showAiError('The reading timed out. The model is busy — please try again shortly.');
    else showAiError('Network trouble — the reading service could not be reached. Please check your connection and retry.');
  } finally {
    clearTimeout(timer);
    aiBusy = false;
    setAiThinking(false);
  }
}

/* ============================================================
 * 滚轮 / 滑动
 *   滚筒（三张牌）→ 滚轮任意方向都进入解读（宽容）；拖动 / 吸附中不触发
 *   解读视图     → 只有向下滚才返回（文字区先滚文字，滚到顶再退）
 *   其他状态     → 滚轮不触发任何切换
 * ============================================================ */

function canAdvance() {
  return state === S.ROW && wheelResting();
}

function onWheel(e) {
  if (canAdvance()) {
    if (Math.abs(e.deltaY) > 4) enterReading();
    return;
  }
  if (state === S.READING && e.deltaY > 4) {
    // 解读区是独立滚动容器：内容没滚到底就不退出（原生滚动负责容器内部）
    const t = el.aiText;
    if (t && t.scrollHeight > t.clientHeight + 2 && t.scrollTop + t.clientHeight < t.scrollHeight - 2) return;
    exitReading();
  }
}

function onTouchStart(e) {
  const t = e.touches[0];
  touchStart = {
    x: t.clientX, y: t.clientY, at: Date.now(),
    inText: !!(e.target.closest && e.target.closest('#aiText')),
  };
}

function onTouchEnd(e) {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dy = t.clientY - touchStart.y;
  const dx = t.clientX - touchStart.x;
  const dt = Date.now() - touchStart.at;
  const isSwipe = Math.abs(dy) > SWIPE_MIN && Math.abs(dy) > Math.abs(dx) * 1.15 && dt < SWIPE_MAX_MS;
  const start = touchStart;
  touchStart = null;
  if (!isSwipe) return;

  if (dy < 0 && canAdvance()) { enterReading(); return; }   // 上滑：滚筒 → 解读（宽容，不要求全翻开）
  if (dy > 0 && state === S.READING) {
    if (start.inText && el.aiText.scrollTop > 2) return;   // 先把文字滚回顶部
    exitReading();
  }
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
  showStarHint(false);
  if (el.wheelLabel) el.wheelLabel.classList.remove('is-on');

  cardsFlipped = [false, false, false];
  zoomIndex = -1;
  wheelLabelIndex = -1;
  for (let i = 0; i < 3; i++) setHitFace(i, false);
  updateHits();

  // 输入框归零并解锁
  el.question.value = '';
  setInputLocked(false);
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
  el.orbRow.style.opacity = '1';

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
  showStarHint(false);
  el.question.value = lastQuestion;
  setInputLocked(true);
  syncRing();

  deckShown = false;
  if (el.deckHit) el.deckHit.hidden = true;

  wheel.a = 0;
  if (wheel.tween) { wheel.tween.kill(); wheel.tween = null; }
  if (scene && scene.ok) scene.wheelApply(wheel.a);

  // 问题 6：单张牌快速展开 → 旋转 → 淡出；同时那次的
  // 三张牌从牌背原位置飞出，落到滚筒槽位（三张已按记录翻开）
  const vanishP = (scene && scene.ok) ? scene.openingVanish() : Promise.resolve();
  if (scene && scene.ok) {
    await scene.dealFromFan(lastReading.map((c) => ({
      src: 'cards/' + TAROT_BY_ID[c.id].file,
      reversed: !!c.reversed,
    })), { fromDeck: true, quick: true });
    for (let i = 0; i < 3; i++) scene.presetFlipped(i);
  } else {
    for (let i = 0; i < 3; i++) setHitFace(i, true);
  }
  await vanishP;

  // 直接进入滚筒（先看牌）；下滑才看那次的解读
  state = S.ROW;
  updateHits();
}

/* ============================================================
 * 点击区对齐（3D 模式按投影；无 3D 模式用固定排布）
 * ============================================================ */

/* 无 3D 时的滚筒：用与 3D 相同的公式算屏幕矩形，图片按当前朝向显示 */
function layoutFallbackWheel() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cardH = Math.min(h * 0.45, w * 1.62);
  const ratio = 0.5625;
  const R = h * 0.275;
  const cy = h * 0.445;
  for (let i = 0; i < 3; i++) {
    const n = el.hits[i];
    if (!n) continue;
    let d = (i * WHEEL_STEP - wheel.a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    const c = Math.cos(d);
    const scale = 0.72 + (1 - 0.72) * Math.max(0, c);
    const cw = cardH * ratio * scale;
    const ch = cardH * scale;
    const y = cy - R * Math.sin(d);
    n.hidden = false;
    n.style.left = (w / 2 - cw / 2) + 'px';
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
  if (meta) img.src = flipped ? 'cards/' + meta.file : 'cards/back.jpg';
}

function updateHits() {
  const wheelView = state === S.ROW;
  const zoomView = state === S.ZOOM;
  for (let i = 0; i < 3; i++) {
    const n = el.hits[i];
    if (!n) continue;
    if (wheelView) {
      setRect(n, scene && scene.ok ? scene.cardRect(i) : null);
      if (scene && scene.ok) {
        // 越靠前的牌点击区越在上层（拖动中避免侧牌盖住居中牌）
        n.style.zIndex = String(10 + Math.round(Math.max(0, wheelFocusCos(i)) * 10));
      }
    } else if (zoomView && zoomIndex === i) {
      setRect(n, scene && scene.ok ? scene.cardRect(i) : null);
      n.style.zIndex = '30';
    } else if (n.hidden === false) {
      n.hidden = true;
    }
  }
}

/* 居中标签：某张牌转到中央（对齐度足够高）时淡入并显示身份 */
let wheelLabelIndex = -1;

function tickWheelUi() {
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
  el.openingTitle = document.getElementById('openingTitle');
  el.openingQuestion = document.getElementById('openingQuestion');
  el.openingField = document.querySelector('.opening-field');
  el.openingHint = document.querySelector('.opening-hint');
  el.ringBtn = document.getElementById('ringBtn');
  el.question = document.getElementById('question');
  el.drawHint = document.getElementById('drawHint');

  el.cardRead = document.getElementById('cardRead');
  el.zoomLabel = document.getElementById('zoomLabel');
  el.readName = document.getElementById('readName');
  el.readBadge = document.getElementById('readBadge');
  el.readKeys = document.getElementById('readKeys');
  el.readText = document.getElementById('readText');

  el.starHint = document.getElementById('starHint');
  el.scrollHint = document.getElementById('scrollHint');
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
    if (el.glNotice) el.glNotice.hidden = true;
  }

  /* ---- 顶部光球 ---- */
  records = readOrbs();
  renderOrbs(records);
  buildStarHint();

  /* ---- 事件 ---- */
  if (el.deckHit) {
    el.deckHit.addEventListener('pointerdown', onDeckPointerDown);
    el.deckHit.addEventListener('click', onDeckClick);
  }
  el.hits.forEach((n, i) => { if (n) n.addEventListener('click', () => onCardHit(i)); });
  if (el.ringBtn) el.ringBtn.addEventListener('click', startDraw);
  if (el.question) {
    el.question.addEventListener('input', syncRing);
    el.question.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); startDraw(); }
    });
  }
  if (el.aiRing) el.aiRing.addEventListener('click', askAi);
  if (el.returnOrb) {
    el.returnOrb.addEventListener('pointerdown', startHold);
    el.returnOrb.addEventListener('pointerup', cancelHold);
    el.returnOrb.addEventListener('pointercancel', cancelHold);
  }
  if (el.orbRow) {
    const pick = (target) => {
      const orb = target && target.closest ? target.closest('.orb') : null;
      if (!orb || !orb.dataset.at) return null;
      return records.filter((r) => String(r.at) === orb.dataset.at)[0] || null;
    };
    el.orbRow.addEventListener('click', (e) => {
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
  }

  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });

  /* 滚筒拖动：窗口级 pointer 事件（按下即跟踪，位移超阈值才算拖动） */
  window.addEventListener('pointerdown', onWheelPtrDown);
  window.addEventListener('pointermove', onWheelPtrMove);
  window.addEventListener('pointerup', onWheelPtrUp);
  window.addEventListener('pointercancel', (e) => {
    if (!wheelPtr || e.pointerId !== wheelPtr.id) return;
    wheelPtr = null;
    wheelRelease(0);
  });

  window.addEventListener('resize', () => { if (scene && scene.ok) scene.resize(); });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (scene && scene.ok) scene.resize(); }, 240);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { if (scene && scene.ok) scene.resize(); });
  }

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
