/* js/app.js — Mucha Tarot · 主逻辑
 *
 * 依赖：
 *   js/data.js       -> TAROT_CARDS / TAROT_BY_ID（全局，经典脚本）
 *   data/meanings.js -> TAROT_MEANINGS（全局）
 *   js/scene.js      -> createTarotScene（ES module）
 *   window.gsap / window.ScrollTrigger（CDN，UMD 全局）
 *
 * 本批次只做「开场」+ 顶部光球展示，流程：
 *   顶部光球（最多 3 个，来自抽牌记录） + 花体标题 + 屏幕中央单张牌背
 *   → 点击牌背：展开成扇形（圆心在页面顶部，牌向下方辐射），标题同时炸成星光并消失
 *   → 扇面下方淡入神秘问句 + 无框输入框 + 传统提示（英文两行） + 泛涟漪光圈
 *
 * 抽牌 / 看牌 / 上滑解读留给后续批次：
 *   showReading / onDraw / AI 相关代码全部保留可用，只是当前没有触发入口
 *   （光圈点击暂时只做轻微脉冲反馈；后续把 onRingClick 接到 onDraw 即可）
 *
 * 不存储任何用户数据：没有 localStorage、没有历史记录。
 */

import { createTarotScene } from './scene.js';

const MAX_QUESTION_LEN = 200;
const POSITIONS = ['过去', '现在', '未来'];
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* 早期版本用 localStorage 存抽牌历史，该功能已移除；顺手清掉遗留键 */
const LEGACY_STORAGE_KEY = 'tarot_history';

/* 开场顶部光球：最多 3 个，从左到右 = 最旧 → 最新 */
const ORB_MAX = 3;
const ORB_STORAGE_KEY = 'tarot_orbs';   // 预留键名（本批次不写入）

const el = {};
let scene = null;
let lastReading = null;      // [{ id, reversed }]
let aiBusy = false;
let readingTrigger = null;
let openingOpened = false;
let ringActive = false;

/* ============================================================
 * 抽牌（后续批次触发）
 * ============================================================ */

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
  return [0, 1, 2].map((i) => ({ id: pool[i].id, reversed: randInt(2) === 1 }));
}

/* ============================================================
 * 渲染（后续批次）
 * ============================================================ */

function elNew(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderReading(cards) {
  el.readingGrid.textContent = '';
  cards.forEach((c, i) => {
    const meta = TAROT_BY_ID[c.id];
    const mean = TAROT_MEANINGS[c.id];
    const rev = !!c.reversed;
    const box = elNew('article', 'read-item');
    box.dataset.cardId = c.id;

    box.appendChild(elNew('p', 'read-pos', POSITIONS[i]));
    box.appendChild(elNew('h3', 'read-name', meta.name));
    box.appendChild(elNew('p', 'read-en', `${meta.en} · ${meta.suitCn}`));
    box.appendChild(elNew('span', 'read-badge' + (rev ? ' is-rev' : ''), rev ? '逆位' : '正位'));

    const thumb = document.createElement('img');
    thumb.className = 'read-thumb';
    thumb.src = 'cards/' + meta.file;
    thumb.alt = `${meta.name}（${rev ? '逆位' : '正位'}）`;
    thumb.loading = 'lazy';
    box.appendChild(thumb);

    const keys = mean ? (rev ? mean.revKeys : mean.upKeys) : [];
    const ul = elNew('ul', 'read-keys');
    keys.forEach((k) => ul.appendChild(elNew('li', null, k)));
    box.appendChild(ul);

    box.appendChild(elNew('p', 'read-text', mean ? (rev ? mean.rev : mean.up) : '暂无牌义数据'));

    el.readingGrid.appendChild(box);
  });
}

function fillSlotLabels(cards) {
  cards.forEach((c, i) => {
    const meta = TAROT_BY_ID[c.id];
    const box = el.slotLabels[i];
    if (!box) return;
    box.querySelector('.slot-name').textContent = meta.name;
    box.querySelector('.slot-badge').textContent = c.reversed ? '逆位' : '正位';
  });
}

/* ============================================================
 * 开场 · 标题炸成星光
 * 用 canvas 画出同字体的标题、读像素，在真实字形位置上生成光点，
 * 因此爆散是从笔画里散开，而不是从一个矩形里冒出。
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
  // 打散后限量，控制 DOM 节点数
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pts[i]; pts[i] = pts[j]; pts[j] = t;
  }
  return pts.slice(0, limit || 260);
}

/* ============================================================
 * 开场 · 标题淡出 + 少量星光散开
 *
 * 旧实现：260 个 DOM 节点、每颗带双层 box-shadow，GSAP 逐颗缩放 ——
 * 缩放会让模糊阴影每帧重新栅格化，实测爆散期间均帧从 28.8ms 涨到 50.6ms、
 * 21 帧超过 50ms、最长一帧 173ms。
 * 现在：标题 0.8s 淡出 + 一块 canvas 一次画完全部星点
 * （1 个合成层、0 DOM 变更、0 box-shadow、26 颗星），空闲时整块 canvas 不显示。
 * ============================================================ */

const BURST_COUNT = 26;          // 星光数量（需求：不要密集粒子爆炸）
const BURST_LIFE = [0.7, 1.3];   // 单颗星存活时长范围（秒）

let burstRaf = 0;
let burstSprite = null;

/* 预渲染一颗柔光星点，之后只 drawImage，避免每帧建渐变 */
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

function startBurst(points, rect) {
  const cv = el.burstLayer;
  if (!cv || !cv.getContext) return;
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

  const sprite = getStarSprite();
  const stars = points.map((p) => {
    const a = Math.random() * Math.PI * 2;
    const d = 44 + Math.random() * 150;
    return {
      x: rect.left + p.x,
      y: rect.top + p.y,
      vx: Math.cos(a) * d,
      vy: Math.sin(a) * d + 26,       // 略偏下：散进标题下方的空旷暗区
      r: 3.4 + Math.random() * 3.4,
      t: 0,
      life: BURST_LIFE[0] + Math.random() * (BURST_LIFE[1] - BURST_LIFE[0]),
    };
  });

  let last = 0;
  const step = (now) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.t += dt;
      const k = s.t / s.life;
      if (k >= 1) continue;
      alive++;
      const out = 1 - Math.pow(1 - k, 2.4);       // 先快后慢地外扩
      const x = s.x + s.vx * out;
      const y = s.y + s.vy * out + 12 * out * out;
      const r = s.r * (0.55 + 0.8 * out) * (1 - 0.35 * k);
      ctx.globalAlpha = Math.max(0, Math.pow(1 - k, 1.5));
      ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    if (alive) {
      burstRaf = requestAnimationFrame(step);
    } else {
      burstRaf = 0;
      ctx.clearRect(0, 0, W, H);
      cv.style.display = 'none';                  // 空闲时整块 canvas 不参与合成
    }
  };
  if (burstRaf) cancelAnimationFrame(burstRaf);
  burstRaf = requestAnimationFrame(step);
}

async function explodeTitle() {
  const node = el.openingTitle;
  if (!node || node.dataset.gone === '1') return;
  node.dataset.gone = '1';

  // 等 webfont 就绪，否则 canvas 量到的字宽是回退字体的
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* 忽略 */ }

  const rect = node.getBoundingClientRect();
  const points = sampleTitlePoints(node, rect, BURST_COUNT);

  if (REDUCED) { node.style.visibility = 'hidden'; return; }

  // 标题淡出 0.8s（旧实现是瞬间隐藏，太生硬）
  if (window.gsap) {
    window.gsap.to(node, {
      opacity: 0,
      duration: 0.8,
      ease: 'power2.inOut',
      onComplete: () => { node.style.visibility = 'hidden'; },
    });
  } else {
    node.style.visibility = 'hidden';
  }

  if (points.length) startBurst(points, rect);
}

/* ============================================================
 * 开场 · 问句 / 输入框 / 光圈淡入
 * ============================================================ */

function showAskArea() {
  // 顺序与视觉顺序一致：问句 → 输入框 → 提示小字 → 光圈
  const targets = [el.openingQuestion, el.openingField, el.openingHint, el.ringBtn]
    .filter(Boolean);
  const gsap = window.gsap;

  if (!gsap || REDUCED) {
    targets.forEach((n) => { n.style.opacity = '1'; n.style.transform = 'none'; });
    focusOnDesktop();
    return;
  }

  gsap.fromTo(targets,
    { opacity: 0, y: 16 },
    {
      opacity: 1, y: 0, duration: 1.0, stagger: 0.16, ease: 'power3.out', delay: 0.8,
      onComplete: focusOnDesktop,
    });
}

/* 桌面端自动落焦点，用户可以直接开始打字；移动端不自动唤起键盘 */
function focusOnDesktop() {
  const fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (fine && el.question) {
    try { el.question.focus({ preventScroll: true }); } catch (e) { el.question.focus(); }
  }
}

/* ============================================================
 * 开场 · 顶部光球展示
 * 最多 3 个，居中对称；从左到右 = 最旧 → 最新。
 * 最旧那颗缓慢呼吸，其余常亮；只有 1 个时也常亮。
 *
 * 本批次只做「静态展示 + 闪烁状态」，不做点击回看 / 炸成星光 / 挤入动画。
 * 数据接口（后续批次接真实记录，UI 无需再改）：
 *   window.TarotOrbs.render(records)   渲染 0–3 个光球
 *   window.TarotOrbs.read()            读取来源（当前返回 []，即不显示）
 * 记录结构约定（后续批次读写共用，本批次只用到数组长度与顺序）：
 *   { at: 毫秒时间戳, question: '提问', cards: [{ id: 'major-00', reversed: false }] }
 * ============================================================ */

function readOrbRecords() {
  // 本批次不做读取：无记录 → 不显示光球。
  // 后续批次把这里换成 JSON.parse(localStorage.getItem(ORB_STORAGE_KEY) || '[]')，
  // 再把结果交给 renderOrbs() 即可。
  void ORB_STORAGE_KEY;
  return [];
}

function renderOrbs(records) {
  if (!el.orbRow) return [];
  const list = (Array.isArray(records) ? records : []).filter(Boolean).slice(-ORB_MAX);

  el.orbRow.textContent = '';
  const nodes = list.map((rec, i) => {
    const orb = document.createElement('span');
    // 最旧的那颗呼吸；只有 1 个时保持常亮
    orb.className = 'orb' + (list.length > 1 && i === 0 ? ' is-aging' : '');
    orb.dataset.index = String(i);
    orb.dataset.at = rec && rec.at != null ? String(rec.at) : '';
    el.orbRow.appendChild(orb);
    return orb;
  });

  el.orbRow.hidden = list.length === 0;
  el.orbRow.dataset.count = String(list.length);

  // 首屏淡入（CSS 里预设了 opacity:0，所以必须用 fromTo，不能用 from）
  if (list.length) {
    const gsap = window.gsap;
    if (gsap && !REDUCED) {
      gsap.fromTo(el.orbRow,
        { opacity: 0, y: -8 },
        { opacity: 1, y: 0, duration: 1.2, ease: 'power3.out', delay: 0.35 });
    } else {
      el.orbRow.style.opacity = '1';
    }
  }
  return nodes;
}

/* 后续批次接入点：光球点击回看、炸成星光、新光球挤入都从这里取数据 */
window.TarotOrbs = {
  max: ORB_MAX,
  storageKey: ORB_STORAGE_KEY,
  read: readOrbRecords,
  render: renderOrbs,
};

/* ============================================================
 * 开场 · 点击牌背展开扇形
 * 拖动（用于看牌的倾斜跟随）不算点击：位移超过阈值就不展开
 * ============================================================ */

const DECK_DRAG_SLOP = 12;      // 按下到抬起的位移阈值（px）
let deckPressAt = null;

function onDeckPointerDown(e) {
  deckPressAt = { x: e.clientX, y: e.clientY };
}

function onDeckClick(e) {
  const moved = deckPressAt
    ? Math.hypot(e.clientX - deckPressAt.x, e.clientY - deckPressAt.y)
    : 0;
  deckPressAt = null;
  if (moved > DECK_DRAG_SLOP) return;
  openFan();
}

function openFan() {
  if (openingOpened) return;
  openingOpened = true;
  if (el.deckHit) el.deckHit.hidden = true;

  if (scene && scene.ok) scene.openingFan();

  // 标题炸散与扇面展开同时开始：先让星光散进上方暗区，卡牌随后才涌上来
  if (window.gsap && !REDUCED) window.gsap.delayedCall(0.06, explodeTitle);
  else explodeTitle();

  showAskArea();
}

/* ============================================================
 * 开场 · 光圈状态
 * 只在「空 ↔ 非空」跳变时切换，避免每次按键都重启动画
 * ============================================================ */

function syncRing() {
  if (!el.ringBtn) return;
  const has = (el.question.value || '').trim().length > 0;
  if (has === ringActive) return;
  ringActive = has;
  el.ringBtn.classList.toggle('is-active', has);
}

function onRingClick() {
  if (!el.ringBtn) return;
  // 本批次不触发抽牌，只给一个轻微脉冲反馈
  el.ringBtn.classList.remove('is-pulsing');
  void el.ringBtn.offsetWidth;      // 重启动画
  el.ringBtn.classList.add('is-pulsing');
  window.setTimeout(() => el.ringBtn.classList.remove('is-pulsing'), 760);
}

/* ============================================================
 * 每帧：把 3D 牌背的投影位置写给透明点击区
 * ============================================================ */

function tickOverlay() {
  requestAnimationFrame(tickOverlay);
  if (!scene || !scene.ok) return;

  const h = window.innerHeight;

  /* 牌背点击区（仅初始态需要；展开后隐藏） */
  if (el.deckHit) {
    const r = openingOpened ? null : scene.openingDeckRect();
    if (r) {
      el.deckHit.hidden = false;
      el.deckHit.style.left = r.x + 'px';
      el.deckHit.style.top = r.y + 'px';
      el.deckHit.style.width = r.w + 'px';
      el.deckHit.style.height = r.h + 'px';
    } else if (!el.deckHit.hidden) {
      el.deckHit.hidden = true;
    }
  }

  /* 牌位标签（后续批次抽牌后使用） */
  if (!document.body.classList.contains('has-draw')) return;
  const stageRect = el.stage.getBoundingClientRect();
  const visible = stageRect.top <= h * 0.28 && stageRect.bottom >= h * 0.72;
  el.stageOverlay.style.opacity = visible ? '1' : '0';
  if (!visible) return;

  for (let i = 0; i < 3; i++) {
    const p = scene.projectSlot(i);
    const y = scene.cardBottomY(i);
    const node = el.slotLabels[i];
    if (!p || y == null || !node) continue;
    node.style.left = p.x + 'px';
    node.style.top = y + 'px';
  }
}

/* ============================================================
 * GSAP 编排（后续批次）
 * ============================================================ */

function revealStageLabels() {
  const labels = el.slotLabels;
  const action = document.querySelector('.stage-action');
  if (!window.gsap || REDUCED) {
    labels.forEach((n) => { n.style.opacity = '1'; });
    if (action) action.style.opacity = '1';
    return;
  }
  // 这两个元素靠 CSS translateX(-50%) 居中，用 GSAP 时必须带 xPercent:-50
  window.gsap.fromTo(labels,
    { opacity: 0, yPercent: -22, xPercent: -50 },
    { opacity: 1, yPercent: 0, xPercent: -50, duration: 0.9, stagger: 0.16, ease: 'power3.out' });
  if (action) {
    window.gsap.fromTo(action,
      { opacity: 0, y: 18, xPercent: -50 },
      { opacity: 1, y: 0, xPercent: -50, duration: 0.9, delay: 0.45, ease: 'power3.out' });
  }
}

function armReadingReveal() {
  if (readingTrigger) { readingTrigger.kill(); readingTrigger = null; }
  if (!window.gsap || !window.ScrollTrigger) return;
  if (REDUCED) { window.gsap.set('.read-item', { opacity: 1, y: 0 }); return; }

  window.gsap.set('.read-item', { opacity: 0, y: 28 });
  readingTrigger = window.ScrollTrigger.create({
    trigger: '#reading',
    start: 'top 80%',
    once: true,
    onEnter: () => {
      window.gsap.to('.read-item', {
        opacity: 1, y: 0, duration: 0.95, stagger: 0.12, ease: 'power3.out',
      });
    },
  });
}

function armSimpleReveal(selector, trigger) {
  if (!window.gsap || !window.ScrollTrigger || REDUCED) return;
  const targets = document.querySelectorAll(selector);
  if (!targets.length) return;
  window.gsap.set(targets, { opacity: 0, y: 24 });
  window.ScrollTrigger.create({
    trigger,
    start: 'top 82%',
    once: true,
    onEnter: () => {
      window.gsap.to(targets, { opacity: 1, y: 0, duration: 0.9, stagger: 0.08, ease: 'power3.out' });
    },
  });
}

function armCameraScroll() {
  if (!scene || !scene.ok || !window.ScrollTrigger) return;
  window.ScrollTrigger.create({
    trigger: '#stage',
    start: 'top top',
    end: '+=900',
    onUpdate: (self) => scene.setScrollProgress(self.progress),
  });
}

/* ============================================================
 * 抽牌主流程（后续批次）
 * ============================================================ */

function showReading(cards, opts) {
  const o = Object.assign({ scroll: true }, opts || {});
  lastReading = cards;

  renderReading(cards);
  fillSlotLabels(cards);

  document.body.classList.add('has-draw');
  armReadingReveal();
  armSimpleReveal('.ai-card', '#aiSection');
  updateAiButton();
  syncQuestionEcho();

  if (o.scroll) {
    requestAnimationFrame(() => {
      el.stage.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    });
  }

  if (scene && scene.ok) {
    scene.reveal(
      cards.map((c) => ({ src: 'cards/' + TAROT_BY_ID[c.id].file, reversed: !!c.reversed })),
      () => revealStageLabels()
    );
  } else {
    revealStageLabels();
  }
}

function setDrawBusy(busy) {
  if (!el.drawBtn2) return;
  el.drawBtn2.disabled = busy;
  el.drawBtn2.textContent = busy ? '正 在 洗 牌' : '再 抽 一 次';
}

function onDraw() {
  if (el.drawBtn2 && el.drawBtn2.disabled) return;
  setDrawBusy(true);
  const cards = drawThree();
  showReading(cards, { scroll: true });
  window.setTimeout(() => setDrawBusy(false), scene && scene.ok ? 900 : 120);
}

/* ============================================================
 * AI 解读
 * ============================================================ */

function updateAiButton() {
  if (!el.aiBtn) return;
  el.aiBtn.disabled = aiBusy || !lastReading;
}

function currentQuestion() {
  return el.question ? (el.question.value || '').trim().slice(0, MAX_QUESTION_LEN) : '';
}

function syncQuestionEcho() {
  if (!el.aiQuestion || !el.aiQuestionEcho) return;
  const q = currentQuestion();
  el.aiQuestionEcho.textContent = q ? `「${q}」` : '';
  el.aiQuestion.hidden = !q;
}

function setAiLoading(on) {
  aiBusy = on;
  el.aiCard.classList.toggle('is-loading', on);
  el.aiBtn.textContent = on ? '正 在 解 读' : 'AI 解 读';
  updateAiButton();
}

function showAiError(msg) {
  el.aiOut.textContent = '';
  el.aiOut.appendChild(elNew('div', 'ai-error', msg));
}

function typeOut(text, done) {
  el.aiOut.textContent = '';

  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const nodes = paras.map((t) => {
    const p = elNew('p', null, '');
    p.dataset.full = t;
    el.aiOut.appendChild(p);
    return p;
  });

  if (nodes.length && /仅供娱乐参考/.test(nodes[nodes.length - 1].dataset.full)) {
    nodes[nodes.length - 1].className = 'ai-disclaimer';
  }

  if (REDUCED) {
    nodes.forEach((p) => { p.textContent = p.dataset.full; });
    if (done) done();
    return;
  }

  const caret = elNew('span', 'ai-caret');
  let pi = 0;
  let ci = 0;

  function step() {
    if (pi >= nodes.length) {
      if (caret.parentNode) caret.parentNode.removeChild(caret);
      if (done) done();
      return;
    }
    const p = nodes[pi];
    const full = p.dataset.full;
    ci = Math.min(full.length, ci + 2);
    p.textContent = full.slice(0, ci);
    p.appendChild(caret);
    if (ci >= full.length) { pi++; ci = 0; }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

async function askAi() {
  if (aiBusy || !lastReading) return;

  const question = currentQuestion();
  setAiLoading(true);
  el.aiOut.textContent = '';
  el.aiOut.appendChild(elNew('p', null, '正在为你读取牌面……'));

  const payload = {
    question,
    cards: lastReading.map((c, i) => {
      const meta = TAROT_BY_ID[c.id];
      const mean = TAROT_MEANINGS[c.id];
      const rev = !!c.reversed;
      return {
        name: meta.name,
        position: POSITIONS[i],
        reversed: rev,
        en: meta.en,
        meaning: mean ? (rev ? mean.rev : mean.up) : '',
        keywords: mean ? (rev ? mean.revKeys : mean.upKeys) : [],
      };
    }),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);

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
      showAiError((data && data.error) || '解读服务暂时不可用，请稍后再试。');
      return;
    }
    typeOut(data.reading);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      showAiError('解读超时了。网络较慢或模型繁忙，请稍后再试一次。');
    } else {
      showAiError('网络不通，解读服务暂时联系不上。请检查网络后重试。');
    }
  } finally {
    clearTimeout(timer);
    setAiLoading(false);
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

  el.opening = document.getElementById('opening');
  el.orbRow = document.getElementById('orbRow');
  el.openingTitle = document.getElementById('openingTitle');
  el.openingQuestion = document.getElementById('openingQuestion');
  el.openingField = document.querySelector('.opening-field');
  el.openingHint = document.querySelector('.opening-hint');
  el.ringBtn = document.getElementById('ringBtn');
  el.question = document.getElementById('question');
  el.drawHint = document.getElementById('drawHint');

  el.stage = document.getElementById('stage');
  el.stageOverlay = document.getElementById('stageOverlay');
  el.slotLabels = Array.prototype.slice.call(document.querySelectorAll('.slot-label'));
  el.drawBtn2 = document.getElementById('drawBtn2');
  el.readingGrid = document.getElementById('readingGrid');
  el.aiCard = document.querySelector('.ai-card');
  el.aiBtn = document.getElementById('aiBtn');
  el.aiQuestion = document.querySelector('.ai-question');
  el.aiQuestionEcho = document.getElementById('aiQuestionEcho');
  el.aiOut = document.getElementById('aiOut');
}

function init() {
  cacheDom();

  // 清掉历史功能遗留的本地数据（该功能已移除）
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) { /* 忽略 */ }

  const dataOk = typeof TAROT_CARDS !== 'undefined' && TAROT_CARDS.length === 78;
  if (!dataOk && el.drawHint) el.drawHint.textContent = '牌面数据加载失败，请刷新页面';

  el.readingGrid.appendChild(elNew('p', 'read-empty', '还没有抽牌。'));

  /* ---- 3D 场景 ---- */
  scene = createTarotScene(el.gl);
  if (!scene.ok) {
    document.body.classList.add('no-3d');
    if (el.glNotice) {
      el.glNotice.hidden = false;
      el.glNotice.querySelector('.gl-notice-title').textContent =
        scene.reason === 'no-webgl' ? '你的浏览器暂不支持 3D 渲染' : '3D 场景未能启动';
      el.glNotice.querySelector('.gl-notice-text').textContent =
        '已切换为简洁模式：点击牌背同样可以展开牌阵。';
    }
    // 无 3D 时用牌背图片顶替，交互保持一致
    if (el.deckHit) el.deckHit.hidden = false;
  } else {
    scene.openingShowDeck();
    if (el.glNotice) el.glNotice.hidden = true;
  }

  window.addEventListener('resize', () => { if (scene && scene.ok) scene.resize(); });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (scene && scene.ok) scene.resize(); }, 240);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (scene && scene.ok) scene.resize();
    });
  }

  /* ---- 事件 ---- */
  if (el.deckHit) {
    el.deckHit.addEventListener('pointerdown', onDeckPointerDown);
    el.deckHit.addEventListener('click', onDeckClick);
  }
  if (el.ringBtn) el.ringBtn.addEventListener('click', onRingClick);
  if (el.question) {
    el.question.addEventListener('input', () => {
      syncRing();
      syncQuestionEcho();
    });
  }
  if (el.drawBtn2) el.drawBtn2.addEventListener('click', onDraw);
  if (el.aiBtn) el.aiBtn.addEventListener('click', askAi);

  /* ---- 开场首屏动效 ---- */
  const gsap = window.gsap;
  if (gsap && !REDUCED && el.openingTitle) {
    gsap.from(el.openingTitle, { y: -18, opacity: 0, duration: 1.4, ease: 'power3.out', delay: 0.15 });
  }

  syncRing();
  syncQuestionEcho();
  updateAiButton();

  /* ---- 顶部光球：本批次无记录 → 不显示；接口已就绪，供后续批次接入 ---- */
  renderOrbs(readOrbRecords());

  tickOverlay();
  armCameraScroll();
}

/* 只读诊断口：调参（漂浮幅度 / 倾角上限）与自动化验证用，不参与任何逻辑 */
window.TarotDebug = {
  sceneReady: () => !!(scene && scene.ok),
  deckRect: () => (scene && scene.openingDeckRect ? scene.openingDeckRect() : null),
  tilt: () => (scene && scene.openingTilt ? scene.openingTilt() : null),
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
