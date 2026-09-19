/* js/app.js — Mucha Tarot · 主逻辑
 *
 * 依赖：
 *   js/data.js       -> TAROT_CARDS / TAROT_BY_ID（全局，经典脚本）
 *   data/meanings.js -> TAROT_MEANINGS（全局）
 *   js/scene.js      -> createTarotScene（ES module）
 *   window.gsap / window.ScrollTrigger（CDN，UMD 全局）
 *
 * 流程：标题 + 提问 + 抽牌按钮 → 抽牌 → 三张牌与牌义 → AI 解读（沿用首屏问题）
 *
 * 不存储任何用户数据：没有 localStorage、没有历史记录、抽牌与提问都不落盘。
 *
 * 双路径：
 *   WebGL 可用   → 3D 卡牌 + 输入框粒子雾；牌义面板只出文字
 *   WebGL 不可用 → body.no-3d，牌义面板补上牌面小图，其余功能照常
 */

import { createTarotScene } from './scene.js';

const MAX_QUESTION_LEN = 200;
const POSITIONS = ['过去', '现在', '未来'];
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* 早期版本用 localStorage 存抽牌历史，该功能已移除；顺手清掉遗留键，避免浏览器里残留抽牌数据 */
const LEGACY_STORAGE_KEY = 'tarot_history';

const el = {};
let scene = null;
let lastReading = null;     // [{ id, reversed }]
let aiBusy = false;
let readingTrigger = null;

/* ============================================================
 * 抽牌
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
 * 渲染
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

    // 只在降级模式（body.no-3d）与窄屏下由 CSS 显示
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

/* fixed 浮层上的三个牌位标签 */
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
 * GSAP 编排
 * ============================================================ */

/* 1) 首屏：标题 → 输入框 → 抽牌按钮，依次淡入上移 */
function introHero() {
  if (!window.gsap || REDUCED) return;
  window.gsap.timeline({ defaults: { ease: 'power3.out' } })
    .from('.anim-hero', { y: 26, opacity: 0, duration: 1.05, stagger: 0.13 }, 0.2);
}

function revealStageLabels() {
  const labels = el.slotLabels;
  const action = document.querySelector('.stage-action');
  if (!window.gsap || REDUCED) {
    labels.forEach((n) => { n.style.opacity = '1'; });
    if (action) action.style.opacity = '1';
    return;
  }
  // 注意：这两个元素在 CSS 里靠 translateX(-50%) 居中，
  // 用 GSAP 时必须带上 xPercent:-50，否则会覆盖 CSS transform 导致偏移。
  window.gsap.fromTo(labels,
    { opacity: 0, yPercent: -22, xPercent: -50 },
    { opacity: 1, yPercent: 0, xPercent: -50, duration: 0.9, stagger: 0.16, ease: 'power3.out' });
  if (action) {
    window.gsap.fromTo(action,
      { opacity: 0, y: 18, xPercent: -50 },
      { opacity: 1, y: 0, xPercent: -50, duration: 0.9, delay: 0.45, ease: 'power3.out' });
  }
}

/* 结果区进入视口触发逐段淡入 */
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

/* 相机随滚动向后拉开 */
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
 * 每帧：读 DOM → 更新 3D 雾气 → 写牌位标签
 * 先读后写，避免读写交错引起布局抖动；scene 内部不再读 DOM。
 * ============================================================ */

function tickOverlay() {
  requestAnimationFrame(tickOverlay);
  if (!scene || !scene.ok) return;

  const h = window.innerHeight;

  /* ---- 读：输入框矩形（用于雾气跟随） ---- */
  let qRect = null;
  let qVis = 0;
  if (el.question) {
    const q = el.question.getBoundingClientRect();
    if (q.bottom > 0 && q.top < h) {
      const fadeIn = Math.min(1, Math.max(0, (h - q.top) / 140));
      const fadeOut = Math.min(1, Math.max(0, q.bottom / 140));
      const focused = document.activeElement === el.question;
      qVis = Math.min(fadeIn, fadeOut) * (focused ? 1 : 0.78);
    }
    qRect = q;
  }

  /* ---- 读：舞台矩形（用于牌位标签显隐） ---- */
  let stageRect = null;
  if (document.body.classList.contains('has-draw')) {
    stageRect = el.stage.getBoundingClientRect();
  }

  /* ---- 写 ---- */
  scene.updateMist(qRect, qVis);

  if (!stageRect) {
    el.stageOverlay.style.opacity = '0';
    return;
  }
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
 * 主流程
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

  /* 抽牌：从空间深处浮现 → 飞向三位 → 依次 3D 翻转（由 scene 内部 GSAP 编排） */
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
  [el.drawBtn, el.drawBtn2].forEach((b) => { if (b) b.disabled = busy; });
  if (el.drawBtn) el.drawBtn.textContent = busy ? '正 在 洗 牌' : '再 抽 一 次';
  if (el.drawBtn2) el.drawBtn2.textContent = '再 抽 一 次';
}

function onDraw() {
  if (el.drawBtn.disabled) return;
  setDrawBusy(true);
  const cards = drawThree();
  showReading(cards, { scroll: true });
  // 首轮要加载贴图，稍晚一点恢复按钮
  setTimeout(() => setDrawBusy(false), scene && scene.ok ? 900 : 120);
}

/* ============================================================
 * AI 解读
 * ============================================================ */

function updateAiButton() {
  if (!el.aiBtn) return;
  el.aiBtn.disabled = aiBusy || !lastReading;
}

/* 提问只在首屏采集，这里统一读取 */
function currentQuestion() {
  return el.question ? (el.question.value || '').trim().slice(0, MAX_QUESTION_LEN) : '';
}

/* 把将被使用的问题回显到 AI 面板；没填就不显示这一行 */
function syncQuestionEcho() {
  if (!el.aiQuestion || !el.aiQuestionEcho) return;
  const q = currentQuestion();
  el.aiQuestionEcho.textContent = q ? `「${q}」` : '';
  el.aiQuestion.hidden = !q;
}

/* 加载状态：呼吸光晕（CSS），不用转圈 */
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

/* 打字机逐字显示 */
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
    p.appendChild(caret);   // appendChild 会移动节点，光标始终停在末尾
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
        // 附上本地牌义，让模型解读与用户眼前看到的牌义一致
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
  el.stage = document.getElementById('stage');
  el.stageOverlay = document.getElementById('stageOverlay');
  el.slotLabels = Array.prototype.slice.call(document.querySelectorAll('.slot-label'));
  el.drawBtn = document.getElementById('drawBtn');
  el.drawBtn2 = document.getElementById('drawBtn2');
  el.drawHint = document.getElementById('drawHint');
  el.readingGrid = document.getElementById('readingGrid');
  el.aiCard = document.querySelector('.ai-card');
  el.aiBtn = document.getElementById('aiBtn');
  el.aiQuestion = document.querySelector('.ai-question');
  el.aiQuestionEcho = document.getElementById('aiQuestionEcho');
  el.aiOut = document.getElementById('aiOut');
  el.question = document.getElementById('question');
}

function init() {
  cacheDom();

  // 清掉历史功能遗留的本地数据（该功能已移除，不再存储任何用户抽牌记录）
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) { /* 隐私模式下可能不可用 */ }

  if (typeof TAROT_CARDS === 'undefined' || TAROT_CARDS.length !== 78) {
    if (el.drawHint) el.drawHint.textContent = '牌面数据加载失败，请刷新页面';
    if (el.drawBtn) el.drawBtn.disabled = true;
    return;
  }

  el.readingGrid.appendChild(elNew('p', 'read-empty', '还没有抽牌。回到上方，点击「开始抽牌」。'));

  /* ---- 3D 场景 ---- */
  scene = createTarotScene(el.gl);
  if (!scene.ok) {
    document.body.classList.add('no-3d');
    if (el.glNotice) {
      el.glNotice.hidden = false;
      el.glNotice.querySelector('.gl-notice-title').textContent =
        scene.reason === 'no-webgl' ? '你的浏览器暂不支持 3D 渲染' : '3D 场景未能启动';
      el.glNotice.querySelector('.gl-notice-text').textContent =
        scene.reason === 'no-webgl'
          ? '页面已切换为简洁模式，抽牌、牌义与 AI 解读都完全正常。'
          : '页面已切换为简洁模式，功能不受影响。';
    }
  }

  window.addEventListener('resize', () => { if (scene && scene.ok) scene.resize(); });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (scene && scene.ok) scene.resize(); }, 240);
  });
  // 移动端键盘弹出会改变可视视口，需要重新布局 3D 并立刻校正雾气位置
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (scene && scene.ok) scene.resize();
      tickOverlay();
    });
  }

  /* ---- 事件 ---- */
  el.drawBtn.addEventListener('click', onDraw);
  if (el.drawBtn2) el.drawBtn2.addEventListener('click', onDraw);
  el.aiBtn.addEventListener('click', askAi);
  el.question.addEventListener('input', syncQuestionEcho);
  el.question.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') askAi();
  });

  /* ---- 首屏 ---- */
  introHero();
  syncQuestionEcho();
  updateAiButton();
  tickOverlay();
  armCameraScroll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
