/* js/scene.js — Three.js 统一 3D 场景（单场景三层）
 *
 * 层级（同一 scene，同一相机，因此相机运动会同时影响三层，产生真实空间感）：
 *   Layer 3  粒子星云   —— Points + ShaderMaterial，默认 30000 粒子，缓慢流动 + 呼吸
 *   Layer 2  仪式舞台   —— 地面金环 + 柔光盘，锚定"仪式空间"
 *   Layer 1  3D 卡牌    —— 有厚度的板体 + 正贴图 + 背贴图 + 金属描边线
 *
 * 对外 API：
 *   ok                  WebGL 是否可用
 *   reason              不可用原因（'no-webgl' | 'disabled' | 'init-failed'）
 *   reveal(cards)       抽牌入场 + 依次翻转，返回 Promise 与 timeline
 *   clear()             收起卡牌
 *   setScrollProgress(p) 0→1，相机随页面向后拉开
 *   projectSlot(i)      第 i 张牌在屏幕上的像素坐标（用于对齐 DOM 标签）
 *   cardBottomY(i)      第 i 张牌底边在屏幕上的 y 像素
 *   resize()
 *   dispose()
 */

import * as THREE from 'three';

/* ============================================================
 * 配置：降级开关集中在这里（按需求「不做自动降级」，但保留开关）
 * ============================================================ */
export const CONFIG = {
  enable3D: true,          // 总开关，false 则走 DOM 降级路径
  particleCount: 30000,    // 星云粒子数（需求默认值）
  nebulaCount: 70,         // 星云柔光团数量
  mistCount: 1100,         // 输入框雾气粒子数（可再降）
  mistOpacity: 0.85,       // 雾气整体强度
  mistZ: -0.35,            // 雾气所在平面
  enableMist: false,       // 开场改用居中无框输入，雾气与它不搭 → 关闭（实现保留，可随时恢复）
  dprMax: 2,               // 设备像素比上限
  enableNebula: true,
  enableFog: true,
  autoDegrade: false,      // 明确关闭：不做性能自动降级
  fov: 42,
  cardDepth: 0.03,
  textureAnisotropyMax: 4,

  /* 开场：单张牌背 → 扇形展开
   * 扇形圆心在「页面顶部的正中竖线上」（实际可能在顶边之上，见 openingLayout），
   * 牌从圆心向下方辐射：外侧牌更高、中间牌最低，长轴沿半径指向圆心。 */
  enableOpening: true,
  fanCount: 9,             // 扇形张数（宽屏）
  fanCountNarrow: 8,       // 扇形张数（窄屏，仍落在 8–10 区间）
  fanGapRatio: 0.75,       // 相邻牌中心距 = 牌宽 × 该比例（越小越叠）
  fanMaxAngle: 0.85,       // 最外侧牌的偏角（弧度，约 49°）：决定弧的深浅
  fanTopRatio: 0.075,      // 扇形最上沿距页面顶部（占视口高度，另有像素下限）
  fanBandRatio: 0.32,      // 扇形所在竖直带的基准高度（占视口高度）
  fanStagger: 0.30,        // 偏离中心每一档的错开时长
  fanFloat: 0.022,         // 展开后各自的浮动幅度（克制：约 7px）
  fanFloatDur: [6.0, 8.5], // 展开后的浮动周期范围（秒，越大越慢）
  fanLean: -0.10,          // 扇形整体向后仰一点，增加立体感

  /* 单张牌背的原地轻摆（不移动位置，只是很慢的左右 + 上下微动） */
  deckFloatX: 0.012,       // 左右摆幅（世界单位，约 4px）
  deckFloatY: 0.018,       // 上下摆幅（约 6px）
  deckFloatDurX: 8.4,      // 左右往返单程时长（秒）
  deckFloatDurY: 10.2,     // 上下往返单程时长（秒）——与 X 不同，避免看出规律

  /* 指针跟随：单张牌背转向并移向鼠标 / 手指（要看得出来，但仍克制） */
  deckTiltMax: 0.14,       // 最大倾角（弧度，约 8°，需求上限 5–8°）
  deckTiltEase: 0.05,      // 每帧插值系数（60fps 下约 0.3s 到位，无弹簧感）
  deckShift: 22,           // 跟随位移上限（屏幕像素，横向）——"跟手"主要靠这段
  deckShiftYRatio: 0.62,   // 纵向位移相对横向的比例（纵向收敛些，避免顶到标题）

  /* 抽牌后的三张牌 */
  dealSpin: 0.75,          // 飞行时多转的圈数（仪式感）
  zoomHeightRatio: 0.52,   // 放大时牌高占视口比例（上方留出金色身份标签的位置）
  zoomCenterY: 0.345,      // 放大时牌心所在的视口高度比例（下方留给牌义文字）
  topHeightRatio: 0.17,    // 固定到顶部时的牌高
  topCenterY: 0.135,       // 顶部牌心所在的视口高度比例

  /* 三张牌滚筒：横向排列（左·中·右），点两侧发光三角形切换
   * 朝向与位置解耦：翻没翻只影响 flipper（牌面/牌背），滚筒只改位置 —— 切到任何位置都保持当前朝向。
   * δ=0 居中（最大、正对相机）；δ=±120° 在右/左（缩小、后撤、朝中心倾转，只露内缘）。 */
  wheelStep: (Math.PI * 2) / 3,  // 相邻两牌在轮上的角距（120°）
  wheelCenterY: 0.445,     // 滚筒中心所在视口高度
  wheelHeightRatio: 0.45,  // 居中牌高（占视口；另有宽度上限）
  wheelRadiusXRatio: 0.58, // 横向轮半径（占视宽）→ 侧牌中心滑到屏幕边缘外，只露内缘
  wheelRadiusYMax: 0.72,   // 半径上限（占视高，宽屏防止侧牌飞太远）
  wheelArcRatio: 0.10,     // 侧牌下沉量（占半径）：轻微弧线，不像死板的直线
  wheelMinScale: 0.66,     // 侧牌缩放下限（透视还会再缩小一点）
  wheelTiltAmp: 0.52,      // 侧牌绕 Y 倾转幅度（rad，coverflow：两侧牌朝中心转）
  wheelDepth: 0.24,        // 侧牌后退深度系数（越大纵深越强）
  wheelDim: 0.78,          // 侧牌不透明度下限（突出中间那张）
  wheelBob: 0.007,         // 落位后的轻微起伏（世界单位，约 1.6px）
};

/* 降级档位建议值（供以后启用 autoDegrade 时使用，当前不自动应用） */
export const DEGRADE_PROFILES = {
  high: { particleCount: 30000, mistCount: 1100, dprMax: 2, enableNebula: true },
  medium: { particleCount: 14000, mistCount: 500, dprMax: 1.5, enableNebula: true },
  low: { particleCount: 6000, mistCount: 0, dprMax: 1, enableNebula: false },
};

/* 开场状态机取值 */
export const OPENING = { IDLE: 'idle', DECK: 'deck', FAN: 'fan', EXIT: 'exit' };

const CARD_W = 1;
const CARD_H = 1 / 0.5625;          // 牌面素材为 1080×1920，宽高比 9:16
const COLOR_GOLD = 0xc9a961;
const COLOR_INK = 0x0a0908;
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ============================================================
 * 工具
 * ============================================================ */

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

/* 用 canvas 生成柔光贴图，避免引入外部素材 */
function makeSoftTexture(size, stops) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  (stops || [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.28)'], [1, 'rgba(255,255,255,0)']])
    .forEach(([o, c]) => g.addColorStop(o, c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================================================
 * 粒子星云（Layer 3）
 * ============================================================ */

const PARTICLE_VERT = /* glsl */ `
  attribute float aScale;
  attribute float aPhase;
  attribute vec3 aTint;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uDrift;     // 漂移幅度倍率：星云用 1，输入框雾气用很小的值
  varying vec3 vTint;
  varying float vAlpha;

  void main() {
    vTint = aTint;

    // 缓慢流动：三轴用不同频率/相位，避免看出规律
    vec3 p = position;
    float t = uTime * 0.055;
    p.x += sin(t + aPhase) * 0.62 * uDrift;
    p.y += cos(t * 0.82 + aPhase * 1.31) * 0.55 * uDrift;
    p.z += sin(t * 0.63 + aPhase * 0.71) * 0.42 * uDrift;

    // 呼吸感
    float breathe = 0.66 + 0.34 * sin(uTime * 0.42 + aPhase * 2.1);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float depth = max(-mv.z, 0.001);

    // 远处的粒子变暗，制造纵深
    float depthFade = smoothstep(52.0, 3.0, depth);
    vAlpha = breathe * depthFade;

    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aScale * uPixelRatio * (13.0 / depth);
    gl_PointSize = clamp(gl_PointSize, 0.5, 34.0);
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  uniform float uOpacity;
  uniform float uSoft;     // 软圆点衰减宽度：星云用小值（点状），雾气用大值（柔霭状）
  varying vec3 vTint;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = smoothstep(0.5, uSoft, d);
    float glow = pow(core, 3.2);
    float a = (core * 0.32 + glow * 0.9) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vTint, a);
  }
`;

function makeParticleMaterial(uSize, uOpacity, uDrift, uSoft) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSize: { value: uSize },
      uOpacity: { value: uOpacity },
      uDrift: { value: uDrift == null ? 1 : uDrift },
      uSoft: { value: uSoft == null ? 0.04 : uSoft },
    },
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/* 生成粒子几何：60% 分布在大球壳，40% 分布在扁平云盘，整体环绕相机 */
function makeParticleGeometry(count, spread) {
  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count);
  const phase = new Float32Array(count);
  const tint = new Float32Array(count * 3);

  // 米白 / 香槟金，低饱和
  const ivory = new THREE.Color(0xe8e2d6);
  const champagne = new THREE.Color(0xc9a961);
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    if (i % 5 < 3) {
      // 球壳
      const r = spread * (0.35 + Math.pow(Math.random(), 0.7) * 0.9);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i3 + 1] = r * Math.cos(phi) * 0.72;
      pos[i3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    } else {
      // 扁平云盘
      const a = Math.random() * Math.PI * 2;
      const r = 2.6 + Math.pow(Math.random(), 0.6) * spread * 1.1;
      pos[i3] = Math.cos(a) * r;
      pos[i3 + 1] = (Math.random() - 0.5) * 3.4;
      pos[i3 + 2] = Math.sin(a) * r * 0.85 - 2.5;
    }
    scale[i] = 0.35 + Math.pow(Math.random(), 2.2) * 1.5;
    phase[i] = Math.random() * Math.PI * 2;

    // 金色占比低一些，整体保持雅致
    tmp.copy(Math.random() < 0.22 ? champagne : ivory);
    tmp.multiplyScalar(0.72 + Math.random() * 0.28);
    tint[i3] = tmp.r; tint[i3 + 1] = tmp.g; tint[i3 + 2] = tmp.b;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  return g;
}

/* 输入框雾气：局部归一化空间（[-1,1] 的扁椭圆），实际尺寸由 group.scale 决定。
 * 约六成粒子走外圈光环（贴着输入框边缘之外），四成是框内极淡的薄雾，
 * 这样文字区域依然干净，可读性不受影响。 */
function makeMistGeometry(count) {
  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count);
  const phase = new Float32Array(count);
  const tint = new Float32Array(count * 3);

  const ivory = new THREE.Color(0xe8e2d6);
  const champagne = new THREE.Color(0xc9a961);
  const tmp = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const halo = i % 5 < 3;

    if (halo) {
      const a = Math.random() * Math.PI * 2;
      const rr = 0.92 + Math.random() * 0.34;
      pos[i3] = Math.cos(a) * rr;
      pos[i3 + 1] = Math.sin(a) * rr * 0.85;
      pos[i3 + 2] = (Math.random() - 0.5) * 1.2;
      scale[i] = 0.55 + Math.pow(Math.random(), 1.8) * 0.85;
    } else {
      pos[i3] = (Math.random() * 2 - 1) * 0.92;
      pos[i3 + 1] = (Math.random() * 2 - 1) * 0.8;
      pos[i3 + 2] = (Math.random() - 0.5) * 0.9;
      scale[i] = 0.22 + Math.random() * 0.34;
    }

    phase[i] = Math.random() * Math.PI * 2;

    tmp.copy(Math.random() < 0.3 ? champagne : ivory);
    tmp.multiplyScalar(halo ? 0.68 + Math.random() * 0.32 : 0.4 + Math.random() * 0.3);
    tint[i3] = tmp.r; tint[i3 + 1] = tmp.g; tint[i3 + 2] = tmp.b;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  return g;
}

/* ============================================================
 * 3D 卡牌（Layer 1）
 * ============================================================ */

/* 贴图缓存：url → THREE.Texture。抽牌时命中缓存即可立即建牌，
 * 未命中的图并行加载、不要阻塞动画（弱网首抽的卡顿元凶）。 */
const texCache = {};
let backTexPromise = null;

/* 牌背图路径：优先 cards/w/back.webp（约 54KB），不支持 WebP 回退 jpg。 */
const BACK_SRC = (() => {
  try { return document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0
    ? 'cards/w/back.webp' : 'cards/back.jpg'; }
  catch (e) { return 'cards/back.jpg'; }
})();

/* 加载贴图。三层防护：
 * ① 真机（微信/弱网）图片请求可能「既不 onLoad 也不 onError」永久挂起 → 每次尝试带硬超时。
 * ② 超时/出错自动重试，全部失败才 resolve(null) 退回纯色牌面，不阻塞抽牌。
 * ③ 关键：用原生 Image 加载并以 naturalWidth 校验——Cloudflare Pages 对不存在的路径
 *    会返回 index.html（HTTP 200 + text/html），TextureLoader 会静默拿到坏图导致牌面空白。
 *    这里 explicit 检查解码尺寸，非图片直接判失败，杜绝"加载成功却空白"。 */
function loadTexture(url, anisotropy, tries = 2, timeout = 7000) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      if (attempt >= tries) { resolve(null); return; }
      attempt++;
      let settled = false;
      const finish = (tex) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(tex);
      };
      const timer = setTimeout(() => { if (!settled) { settled = true; tryOnce(); } }, timeout);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (settled) return;
        /* 非图片内容（如被 fallback 成 HTML）尺寸为 0 → 视为失败 */
        if (!img.naturalWidth || !img.naturalHeight) { settled = true; tryOnce(); return; }
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = anisotropy;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        finish(tex);
      };
      img.onerror = () => { if (!settled) { settled = true; tryOnce(); } };
      img.src = url;
    };
    tryOnce();
  });
}

function buildCard(backTex, faceTex, anisotropy) {
  const root = new THREE.Group();
  const flipper = new THREE.Group();   // 绕 Y 轴翻转（牌背 → 牌面）
  const spin = new THREE.Group();      // 绕 Z 轴旋转 180°（逆位）
  root.add(flipper);
  flipper.add(spin);

  const materials = [];

  // 牌体：有厚度的板
  const slabGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CONFIG.cardDepth);
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0x17130f, roughness: 0.44, metalness: 0.72,
    transparent: true, opacity: 1,
  });
  materials.push(slabMat);
  const slab = new THREE.Mesh(slabGeo, slabMat);
  spin.add(slab);

  // 金属描边：细金线（WebGL 线宽固定 1px，正合"细"的要求）
  const edgeGeo = new THREE.EdgesGeometry(slabGeo);
  const edgeMat = new THREE.LineBasicMaterial({
    color: COLOR_GOLD, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  materials.push(edgeMat);
  spin.add(new THREE.LineSegments(edgeGeo, edgeMat));

  const halfD = CONFIG.cardDepth / 2 + 0.0012;

  // 牌面：map + emissiveMap，保证画面雅致但不过暗
  const faceMat = new THREE.MeshStandardMaterial({
    color: faceTex ? 0xffffff : 0x2a221b,
    map: faceTex,
    emissive: 0xffffff,
    emissiveMap: faceTex,
    emissiveIntensity: faceTex ? 0.46 : 0,
    roughness: 0.6,
    metalness: 0.08,
    transparent: true, opacity: 1,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,   // 贴面偏离牌体，消除深度闪动
  });
  materials.push(faceMat);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), faceMat);
  face.position.z = halfD;
  spin.add(face);

  // 牌背：平面绕 Y 轴 180°，保证从背面看不镜像
  const backMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: backTex,
    emissive: 0xffffff,
    emissiveMap: backTex,
    emissiveIntensity: 0.22,
    roughness: 0.52,
    metalness: 0.2,
    transparent: true, opacity: 1,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,   // 贴面偏离牌体，消除深度闪动
  });
  materials.push(backMat);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), backMat);
  back.position.z = -halfD;
  back.rotation.y = Math.PI;
  spin.add(back);

  // 初始：牌背朝向相机
  flipper.rotation.y = Math.PI;

  return {
    root, flipper, spin, materials,
    faceTex, backTex,
    /* 牌面图迟到时（首抽超时/null）补贴：自动把纯色牌面换成真实卡图 */
    setFaceTex(tex) {
      faceTex = tex;
      faceMat.map = tex;
      faceMat.emissiveMap = tex;
      faceMat.color.set(0xffffff);
      faceMat.emissive.set(0xffffff);
      faceMat.emissiveIntensity = 0.46;
      faceMat.needsUpdate = true;
    },
    /* 牌背图迟到时补贴 */
    setBackTex(tex) {
      backTex = tex;
      backMat.map = tex;
      backMat.emissiveMap = tex;
      backMat.needsUpdate = true;
    },
    setOpacity(v) {
      materials.forEach((m) => { m.opacity = v; });
      root.visible = v > 0.001;
    },
    dispose() {
      slabGeo.dispose(); edgeGeo.dispose();
      face.geometry.dispose(); back.geometry.dispose();
      materials.forEach((m) => m.dispose());
      if (faceTex) faceTex.dispose();
    },
  };
}

/* ============================================================
 * 主入口
 * ============================================================ */

export function createTarotScene(container) {
  const api = {
    ok: false, reason: null, ready: false,
    reveal: () => Promise.resolve(),
    clear: () => {},
    setScrollProgress: () => {},
    projectSlot: () => null,
    cardBottomY: () => null,
    updateMist: () => {},
    openingShowDeck: () => Promise.resolve(),
    preloadFaces: () => {},
    openingVanish: () => Promise.resolve(),
    openingFan: () => null,
    openingDeckRect: () => null,
    openingTilt: () => ({ x: 0, y: 0, degX: 0, degY: 0, targetX: 0, targetY: 0, shiftX: 0, shiftY: 0 }),
    dealFromFan: () => Promise.resolve(null),
    flipCard: () => null,
    zoomCard: () => null,
    setView: () => null,
    getView: () => 'wheel',
    getZoomed: () => -1,
    wheelApply: () => {},
    cardRect: () => null,
    fadeReading: () => null,
    resetReading: () => {},
    resize: () => {},
    dispose: () => {},
  };

  if (!CONFIG.enable3D) { api.reason = 'disabled'; return api; }
  if (!hasWebGL()) { api.reason = 'no-webgl'; return api; }

  let renderer, scene, camera, particles, nebula, stageGroup, cardGroup;
  let clock, raf = null;
  let scrollP = 0, smoothP = 0;
  let orbitPhase = 0;
  let slots = [];
  let cardScale = 1;
  let current = [];       // 当前三张卡
  let disposed = false;

  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    renderer.setClearColor(COLOR_INK, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.26;
    container.appendChild(renderer.domElement);
  } catch (e) {
    api.reason = 'init-failed';
    return api;
  }

  const size = () => ({
    w: container.clientWidth || window.innerWidth,
    h: container.clientHeight || window.innerHeight,
  });

  scene = new THREE.Scene();
  if (CONFIG.enableFog) scene.fog = new THREE.FogExp2(COLOR_INK, 0.02);

  camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, 0.1, 220);
  camera.position.set(0, 0.35, 5.2);

  /* ---------- Layer 3：粒子星云 ---------- */
  const anisotropy = Math.min(
    renderer.capabilities.getMaxAnisotropy(),
    CONFIG.textureAnisotropyMax
  );
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.dprMax);

  particles = new THREE.Points(
    makeParticleGeometry(CONFIG.particleCount, 18),
    makeParticleMaterial(1.55, 1)
  );
  particles.frustumCulled = false;
  scene.add(particles);

  if (CONFIG.enableNebula) {
    nebula = new THREE.Points(
      makeParticleGeometry(CONFIG.nebulaCount, 26),
      makeParticleMaterial(30, 0.062, 1)
    );
    nebula.frustumCulled = false;
    scene.add(nebula);
  }

  /* ---------- 输入框雾气（跟随 DOM 元素，只在首屏出现） ---------- */
  let mist = null;
  let mistRect = null;      // 由 app.js 每帧传入的屏幕像素矩形
  let mistTarget = 0;       // 目标不透明度
  let mistAlpha = 0;        // 平滑后的实际不透明度

  if (CONFIG.enableMist && CONFIG.mistCount > 0) {
    mist = new THREE.Points(
      makeMistGeometry(CONFIG.mistCount),
      makeParticleMaterial(2.4, 0, 0.045, 0.32)
    );
    mist.frustumCulled = false;
    mist.visible = false;
    scene.add(mist);
  }

  /* ---------- Layer 2：仪式舞台 ---------- */
  stageGroup = new THREE.Group();
  scene.add(stageGroup);

  const glowTex = makeSoftTexture(256, [
    [0, 'rgba(201,169,97,0.55)'],
    [0.35, 'rgba(201,169,97,0.16)'],
    [1, 'rgba(201,169,97,0)'],
  ]);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 11),
    new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, -1.45, -0.4);
  stageGroup.add(glow);

  const ringMat = new THREE.MeshBasicMaterial({
    color: COLOR_GOLD, transparent: true, opacity: 0.15,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  [[2.35, 2.39], [3.05, 3.075]].forEach(([r0, r1]) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 160), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, -1.44, -0.4);
    stageGroup.add(ring);
  });

  /* ---------- 光影 ---------- */
  scene.add(new THREE.AmbientLight(0xede8e0, 0.85));
  const key = new THREE.DirectionalLight(0xfff3dc, 1.45);
  key.position.set(2.6, 3.2, 4.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(COLOR_GOLD, 0.45);
  rim.position.set(-3.2, -1.4, -2.6);
  scene.add(rim);
  const fill = new THREE.PointLight(0xc9a961, 7, 15, 2);
  fill.position.set(0, -1.2, 2.4);
  scene.add(fill);

  /* ---------- Layer 1：卡牌容器 ---------- */
  cardGroup = new THREE.Group();
  scene.add(cardGroup);

  /* ---------- 布局 ---------- */
  /* 顶部视图的三个槽位：每次重算，避免用到过期的相机矩阵。
   * 解读视图要求：三张等大、横向等距、顶部对齐、整体居中（无透视差、无倾转）。 */
  function computeTopSlots() {
    const { w, h } = size();
    const topH = Math.min(h * CONFIG.topHeightRatio, w * 0.30 * (CARD_H / CARD_W));
    const topScale = topH / worldToPixels(CARD_H, 0);
    const topSpread = topScale * 1.24;
    const topC = screenToWorld(w / 2, h * CONFIG.topCenterY, 0, new THREE.Vector3());
    topSlots = [
      { x: topC.x - topSpread, y: topC.y, z: 0, rotY: 0, scale: topScale },
      { x: topC.x, y: topC.y, z: 0, rotY: 0, scale: topScale },
      { x: topC.x + topSpread, y: topC.y, z: 0, rotY: 0, scale: topScale },
    ];
  }

  function layout() {
    const { w, h } = size();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    /* 先同步一次相机矩阵：下面的 screenToWorld / worldToPixels 依赖
     * projectionMatrix 与 matrixWorldInverse，否则首次布局（还没渲染过）会算错 */
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const vFov = THREE.MathUtils.degToRad(CONFIG.fov);
    const tanHalf = Math.tan(vFov / 2);
    const visH = 2 * tanHalf * camera.position.z;          // z=0 平面上的可视高度
    const visW = visH * camera.aspect;

    // 纵深错位：宽屏用 0.62，窄屏收小，避免透视过强导致排列不齐
    const zOff = camera.aspect < 0.9 ? 0.45 : 0.62;
    // 最近那张牌所在平面（出现得最大），水平排布必须按这个平面算才不会溢出
    const visWnear = 2 * tanHalf * (camera.position.z - zOff) * camera.aspect;

    // 三张牌 + 两道间隙必须落在 92% 视宽内；gapRatio 是间隙占牌宽的比例
    const gapRatio = 0.14;
    const wByWidth = (visWnear * 0.92) / (3 + 2 * gapRatio);
    const wByHeight = (visH * 0.53) / CARD_H;
    const cardW = Math.max(0.34, Math.min(wByWidth, wByHeight));
    cardScale = cardW;                                      // CARD_W 恒为 1
    const spread = cardW * (1 + gapRatio);                   // 保证不重叠

    slots = [
      { x: -spread, y: 0, z: -zOff, rotY: 0.07, scale: cardScale },   // 过去：稍远
      { x: 0, y: 0, z: 0, rotY: 0, scale: cardScale },                // 现在：居中
      { x: spread, y: 0, z: zOff, rotY: -0.07, scale: cardScale },    // 未来：稍近
    ];

    /* 顶部视图：三张牌缩小贴顶（上滑进解读时用），下方留给光圈与解读文字 */
    computeTopSlots();

    current.forEach((c, i) => {
      if (!slots[i]) return;
      c.root.scale.setScalar(cardScale);
      if (!c.flying) {
        c.root.position.set(slots[i].x, slots[i].y, slots[i].z);
        c.root.rotation.y = slots[i].rotY;
      }
    });
    camera.updateProjectionMatrix();
  }

  /* ---------- 屏幕投影（给 DOM 标签对齐用） ---------- */
  const tmpVec = new THREE.Vector3();

  function project(world, offsetY = 0) {
    const { w, h } = size();
    tmpVec.set(world.x, world.y + offsetY, world.z);
    tmpVec.project(camera);
    return {
      x: (tmpVec.x * 0.5 + 0.5) * w,
      y: (-tmpVec.y * 0.5 + 0.5) * h,
      behind: tmpVec.z > 1,
    };
  }

  api.projectSlot = (i) => {
    if (!slots[i]) return null;
    return project(slots[i]);
  };
  api.cardBottomY = (i) => {
    if (!slots[i]) return null;
    return project(slots[i], -(CARD_H * cardScale) / 2 - 0.11).y;
  };

  /* ---------- 屏幕像素 → 世界坐标（雾气定位用） ---------- */
  const rayVec = new THREE.Vector3();

  // 屏幕像素点 (cx, cy) 在指定 z 平面上对应的世界坐标
  function screenToWorld(cx, cy, planeZ, out) {
    const { w, h } = size();
    rayVec.set((cx / w) * 2 - 1, -((cy / h) * 2 - 1), 0.5).unproject(camera);
    rayVec.sub(camera.position).normalize();
    const t = (planeZ - camera.position.z) / rayVec.z;
    return out.copy(camera.position).addScaledVector(rayVec, t);
  }

  // 指定 z 平面上，N 个屏幕像素对应多少世界单位
  function pixelsToWorld(px, planeZ) {
    const { w } = size();
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(CONFIG.fov) / 2);
    const dist = Math.max(0.1, camera.position.z - planeZ);
    return (px / w) * (2 * tanHalf * dist * camera.aspect);
  }

  // 上面的反函数：世界长度对应多少屏幕像素
  function worldToPixels(world, planeZ) {
    const { w } = size();
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(CONFIG.fov) / 2);
    const dist = Math.max(0.1, camera.position.z - planeZ);
    return (world / (2 * tanHalf * dist * camera.aspect)) * w;
  }

  /* app.js 每帧传入输入框的屏幕矩形与可见度，这里只做数值缓存，不读 DOM */
  api.updateMist = function (rect, visible) {
    if (!mist) return;
    if (!rect || !(visible > 0)) {
      mistRect = null;
      mistTarget = 0;
      return;
    }
    mistRect = {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height,
    };
    mistTarget = Math.min(1, Math.max(0, visible));
  };

  /* ============================================================
   * 开场：单张牌背（屏幕中央）→ 扇形（圆心在页面顶部，牌向下方辐射，覆盖上方约 1/3）
   * 位置全部由屏幕坐标反算世界坐标，因此和 DOM 布局始终对得上。
   * ============================================================ */
  let openingGroup = null;
  let openingCards = [];
  let openingState = OPENING.IDLE;
  let openingBusy = false;
  let openingBackTex = null;
  let deckSlot = { x: 0, y: 0, z: 0 };
  let deckScale = 1;
  let fanScale = 1;
  let fanH = 0;
  let fanSlots = [];
  /* 漩涡退场需要的扇形几何（openingLayout 里算好存下） */
  let pivotScreen = { x: 0, y: 0 };   // 扇形圆心（屏幕像素，可能在页面上方）
  let fanRadiusPx = 1;
  let fanCardWpx = 1;

  function openingLayout() {
    const { w, h } = size();

    // 单张牌：屏幕正中央（占视口 42%）
    const deckH = pixelsToWorld(Math.min(h * 0.42, 420), 0);
    deckScale = deckH / CARD_H;
    const d = screenToWorld(w / 2, h * 0.50, 0, new THREE.Vector3());
    deckSlot = { x: d.x, y: d.y, z: 0 };

    /* 扇形：圆心在页面顶部正中竖线上，牌向下方辐射（穹形，不是手持扇那种凸上）
     * 半径由「最外侧牌的水平偏移 = 半个展开宽度」反推，展开宽度同时受屏幕宽度硬约束；
     * 圆心 y 不写死，而是先量出整团牌的实际上下范围，再让它落进上方那条带里——
     * 因此圆心通常落在页面顶边之上，这正是「从页面顶部向下方辐射」的观感来源。 */
    const narrow = (w / h) < 0.9;
    const count = narrow ? CONFIG.fanCountNarrow : CONFIG.fanCount;
    const cardHpx = Math.min(h * 0.20, narrow ? 180 : 200);
    const cardWpx = cardHpx * (CARD_W / CARD_H);
    const availW = w * (narrow ? 0.92 : 0.78);

    const maxSpan = Math.max(0, availW - cardWpx);
    const wantSpan = cardWpx * CONFIG.fanGapRatio * (count - 1);
    const spanPx = Math.min(wantSpan, maxSpan);

    fanH = pixelsToWorld(cardHpx, 0);
    fanScale = fanH / CARD_H;

    const aMax = CONFIG.fanMaxAngle;
    const radiusPx = Math.max(1, (spanPx / 2) / Math.sin(aMax));
    fanRadiusPx = radiusPx;
    fanCardWpx = cardWpx;

    // 先以圆心为原点排出每张牌（向下为正），并量出各自旋转后的竖直半高
    const raw = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i - (count - 1) / 2) / ((count - 1) / 2);   // -1 .. 1
      const a = t * aMax;
      const halfV = (cardHpx * Math.cos(a) + cardWpx * Math.sin(Math.abs(a))) / 2;
      raw.push({ t, a, dx: Math.sin(a) * radiusPx, dy: Math.cos(a) * radiusPx, halfV });
    }
    const topMost = Math.min.apply(null, raw.map((r) => r.dy - r.halfV));
    const botMost = Math.max.apply(null, raw.map((r) => r.dy + r.halfV));
    const spanH = Math.max(1, botMost - topMost);

    const bandTop = Math.max(52, h * CONFIG.fanTopRatio);
    const bandH = Math.max(spanH, h * CONFIG.fanBandRatio);
    const pivotYpx = bandTop + (bandH - spanH) / 2 - topMost;   // 圆心的屏幕 y（可为负 = 在页面之上）
    pivotScreen = { x: w / 2, y: pivotYpx };

    const pivot = screenToWorld(w / 2, pivotYpx, 0, new THREE.Vector3());

    // z：扇形弧度带来的前后层次 + 按索引固定递进，保证相邻牌间距恒 > 牌体厚度（否则中间几张 z 近似 →
    // 牌体互相穿插 → 深度闪动）。t≈0 的中间牌原本都挤在 z=0 同一平面。
    const fanGap = CONFIG.cardDepth * 1.8;
    fanSlots = raw.map((r, i) => ({
      t: r.t,
      x: pivot.x + pixelsToWorld(r.dx, 0),
      y: pivot.y - pixelsToWorld(r.dy, 0),        // 屏幕向下 = 世界 -y
      z: -Math.abs(r.t) * 0.30 - i * fanGap,
      rotZ: r.a,                                  // 长轴沿半径 → 牌自顶部圆心向外辐射
    }));
  }

  /* 布局用的张数可能小于已建张数（窄屏 8 / 宽屏 9），多出来的隐藏掉 */
  function openingSyncVisibility() {
    openingCards.forEach((c, i) => {
      if (openingState === OPENING.FAN) {
        const s = fanSlots[i];
        c.root.visible = !!s;
      }
    });
  }

  function openingStopFloat() {
    openingCards.forEach((c) => {
      if (!c.floatTween) return;
      const ts = Array.isArray(c.floatTween) ? c.floatTween : [c.floatTween];
      ts.forEach((tw) => tw.kill());
      c.floatTween = null;
    });
  }

  /* 展开后各自缓慢起伏，相位与周期都错开 */
  function openingStartFloat() {
    const gsap = window.gsap;
    if (!gsap) return;
    openingStopFloat();
    const [d0, d1] = CONFIG.fanFloatDur;
    openingCards.forEach((c, i) => {
      const s = fanSlots[i];
      if (!s) return;
      c.floatTween = gsap.to(c.root.position, {
        y: s.y + CONFIG.fanFloat,
        duration: d0 + (i % 5) * ((d1 - d0) / 4),
        yoyo: true, repeat: -1, ease: 'sine.inOut',
        delay: i * 0.17,
      });
    });
  }

  /* 建立 9 张牌背（共用同一张背图，开销很小） */
  async function openingBuild() {
    if (openingGroup) return;
    /* 首屏就预热牌背：写入缓存，抽牌时即可零等待命中 */
    backTexPromise = loadTexture(BACK_SRC, anisotropy);
    openingBackTex = await backTexPromise;
    if (openingBackTex) texCache[BACK_SRC] = openingBackTex;
    openingGroup = new THREE.Group();
    scene.add(openingGroup);
    openingCards = [];
    const build = Math.max(CONFIG.fanCount, CONFIG.fanCountNarrow);
    for (let i = 0; i < build; i++) {
      const card = buildCard(openingBackTex, null, anisotropy);
      card.root.visible = false;
      card.setOpacity(0);
      openingGroup.add(card.root);
      openingCards.push(card);
    }
  }

  /* 空闲时后台分批预热全部牌面（78 张，webp 约 54KB/张 → 共 ~4MB）。
   * 用户看开场/提问的十几秒里基本能加载完，抽牌时命中缓存即"秒出"。
   * 每批 6 张、批间隔 250ms，避免抢首屏带宽与主线程。 */
  let preloadStarted = false;
  function preloadFaces(files) {
    if (preloadStarted || !files || !files.length) return;
    preloadStarted = true;
    let idx = 0;
    const step = () => {
      const batch = files.slice(idx, idx + 6);
      idx += 6;
      batch.forEach((src) => {
        if (texCache[src]) return;
        loadTexture(src, anisotropy).then((t) => { if (t) texCache[src] = t; });
      });
      if (idx < files.length) setTimeout(step, 250);
    };
    setTimeout(step, 600);   // 让首屏先站稳
  }

  /* 单张牌背的「原地轻摆 + 指针跟随」全部在渲染循环里逐帧计算
   * （时间驱动轻摆 + 指针驱动倾斜/位移，两者相加后一次性写 position，
   *  避免 GSAP 补间和跟随逻辑抢同一个属性）。
   * 这里只负责复位基准与跟随量，在显示初始态与视口变化时调用。 */
  function openingFloatDeck() {
    const c = openingCards[0];
    if (!c) return;
    shiftNow.x = 0;
    shiftNow.y = 0;
    shiftTo.x = 0;
    shiftTo.y = 0;
    c.root.position.set(deckSlot.x, deckSlot.y, deckSlot.z);
  }

  /* ============================================================
   * 指针跟随：单张牌背微微转向 / 微微移向鼠标或手指（跟随感要看得出来）
   * 只有初始态（DECK）才跟随 —— 展开成扇形后牌各有姿态，不参与。
   * 桌面：鼠标移动即跟随；移动端：按住拖动才跟随；松手 / 移出窗口回到原位。
   * ============================================================ */
  const tiltNow = { x: 0, y: 0 };     // 当前倾角（弧度）
  const tiltTo = { x: 0, y: 0 };      // 目标倾角
  const shiftNow = { x: 0, y: 0 };    // 当前跟随位移（世界单位）
  const shiftTo = { x: 0, y: 0 };     // 目标跟随位移
  let tiltDragging = false;
  let tiltLastMs = 0;

  function tiltFromPointer(clientX, clientY) {
    const { w, h } = size();
    const nx = Math.max(-1, Math.min(1, (clientX - w / 2) / (w / 2)));
    const ny = Math.max(-1, Math.min(1, (clientY - h / 2) / (h / 2)));
    // 鼠标在右 → 绕 Y 正向转（牌面朝右）；在上 → 绕 X 负向转（牌面朝上）
    tiltTo.x = ny * CONFIG.deckTiltMax;
    tiltTo.y = nx * CONFIG.deckTiltMax;
    // 同时朝指针方向轻微平移（"跟手"主要靠这一段，比纯旋转明显得多）
    // 注意：屏幕 +y 向下、世界 +y 向上，所以纵向要取反号
    const sx = pixelsToWorld(CONFIG.deckShift, 0);
    const sy = pixelsToWorld(CONFIG.deckShift * CONFIG.deckShiftYRatio, 0);
    shiftTo.x = nx * sx;
    shiftTo.y = -ny * sy;
  }

  function tiltReset() {
    tiltTo.x = 0;
    tiltTo.y = 0;
    shiftTo.x = 0;
    shiftTo.y = 0;
    tiltDragging = false;
  }

  function onTiltDown(e) {
    if (openingState !== OPENING.DECK) return;
    tiltDragging = true;
    tiltFromPointer(e.clientX, e.clientY);
  }

  function onTiltMove(e) {
    if (openingState !== OPENING.DECK) return;
    // 手指：必须按住拖动；鼠标：直接跟随
    if (e.pointerType === 'touch' && !tiltDragging) return;
    tiltFromPointer(e.clientX, e.clientY);
  }

  window.addEventListener('pointerdown', onTiltDown, { passive: true });
  window.addEventListener('pointermove', onTiltMove, { passive: true });
  window.addEventListener('pointerup', tiltReset, { passive: true });
  window.addEventListener('pointercancel', tiltReset, { passive: true });
  window.addEventListener('blur', tiltReset);

  /* 倾角 / 位移诊断（验证与调参用） */
  api.openingTilt = () => ({
    x: tiltNow.x, y: tiltNow.y, degX: tiltNow.x * 180 / Math.PI, degY: tiltNow.y * 180 / Math.PI,
    targetX: tiltTo.x, targetY: tiltTo.y,
    /* 位移按屏幕方向给（正值 = 向右 / 向下），便于验证与读数 */
    shiftX: worldToPixels(shiftNow.x, 0),
    shiftY: -worldToPixels(shiftNow.y, 0),
  });

  /* 历史回看进入：单张牌背快速展开（小幅扇形）→ 旋转 + 缩小 + 淡出。
   * 从牌堆态（DECK）或扇形态（FAN）都能走；返回 Promise，动画结束后牌全部收场。 */
  api.openingVanish = function () {
    const gsap = window.gsap;
    if (!openingGroup || !openingCards.length || openingState === OPENING.EXIT) {
      return Promise.resolve();
    }
    openingStopFloat();
    tiltReset();
    const fromFan = openingState === OPENING.FAN;
    openingState = OPENING.EXIT;

    if (!gsap) {
      openingCards.forEach((c) => { c.root.visible = false; c.setOpacity(0); });
      return Promise.resolve();
    }

    return new Promise((res) => {
      const tl = gsap.timeline({
        onComplete: () => {
          openingCards.forEach((c) => { c.root.visible = false; c.setOpacity(0); });
          res();
        },
      });

      if (!fromFan) {
        // 先快速展开成小幅扇形（0.3s）
        openingLayout();
        const count = fanSlots.length;
        openingCards.forEach((c, i) => {
          const s = fanSlots[i];
          if (!s) { c.root.visible = false; c.setOpacity(0); return; }
          c.root.visible = true;
          c.setOpacity(1);
          c.root.scale.setScalar(deckScale);
          c.root.position.set(deckSlot.x, deckSlot.y, deckSlot.z - i * 0.012);
          c.root.rotation.set(0, 0, (i - (count - 1) / 2) * 0.016);
        });
        openingCards.forEach((c, i) => {
          const s = fanSlots[i];
          if (!s) return;
          tl.to(c.root.position, { x: s.x, y: s.y, z: s.z, duration: 0.3, ease: 'power2.out' }, 0);
          tl.to(c.root.rotation, { x: CONFIG.fanLean, z: s.rotZ * 0.8, duration: 0.3, ease: 'power2.out' }, 0);
          tl.to(c.root.scale, { x: fanScale * 0.85, y: fanScale * 0.85, z: fanScale * 0.85, duration: 0.28, ease: 'power2.out' }, 0);
        });
      }

      // 再旋转 + 缩小 + 淡出（0.5s，外侧牌稍错开）
      const n = openingCards.length;
      openingCards.forEach((c, i) => {
        const d = fromFan ? 0.04 * Math.abs(i - (n - 1) / 2) : 0.26 + 0.035 * Math.abs(i - (n - 1) / 2);
        tl.to(c.root.rotation, { y: (i % 2 ? 1 : -1) * 1.15, duration: 0.5, ease: 'power2.in' }, d);
        tl.to(c.root.scale, { x: 0.001, y: 0.001, z: 0.001, duration: 0.46, ease: 'power2.in' }, d);
        tl.to({ v: c.materials[0].opacity }, {
          v: 0, duration: 0.42, ease: 'power2.in',
          onUpdate: function () { c.setOpacity(this.targets()[0].v); },
        }, d);
      });
    });
  };

  api.preloadFaces = function (files) { preloadFaces(files); };

  /* 初始态：屏幕中央一张牌背 */
  api.openingShowDeck = async function () {
    if (!CONFIG.enableOpening) return;
    await openingBuild();
    openingState = OPENING.DECK;
    openingStopFloat();
    openingLayout();
    openingCards.forEach((c, i) => {
      c.root.visible = i === 0;
      c.setOpacity(i === 0 ? 1 : 0);
      c.root.scale.setScalar(deckScale);
      c.root.position.set(deckSlot.x, deckSlot.y, deckSlot.z - i * 0.01);
      c.root.rotation.set(0, 0, 0);
    });

    const gsap = window.gsap;
    if (gsap) {
      openingCards[0].setOpacity(0);
      gsap.fromTo(openingCards[0].root.scale,
        { x: deckScale * 0.9, y: deckScale * 0.9, z: deckScale * 0.9 },
        { x: deckScale, y: deckScale, z: deckScale, duration: 1.4, ease: 'power3.out' });
      gsap.to({ v: 0 }, {
        v: 1, duration: 1.1, ease: 'power2.out',
        onUpdate: function () { openingCards[0].setOpacity(this.targets()[0].v); },
      });
      openingFloatDeck();
    } else {
      openingCards[0].setOpacity(1);
    }
  };

  /* 点击牌背 → 展开成扇形；返回 timeline（无 GSAP 时返回 null） */
  api.openingFan = function () {
    if (!CONFIG.enableOpening || !openingGroup) return null;
    if (openingState === OPENING.FAN || openingBusy) return null;

    const gsap = window.gsap;
    openingStopFloat();
    tiltReset();                 // 展开后不再跟随指针
    openingLayout();

    // 先把牌叠回牌堆位置（像一叠牌）。
    // 间隔必须 > 牌体厚度（cardDepth 0.03），否则相邻牌体穿插 → z-fighting 闪动。
    const fanSlotsCount = fanSlots.length;
    const stackGap = CONFIG.cardDepth * 1.8;
    openingCards.forEach((c, i) => {
      c.root.visible = i < fanSlotsCount;
      c.setOpacity(1);
      c.root.scale.setScalar(deckScale);
      c.root.position.set(deckSlot.x, deckSlot.y, deckSlot.z - i * stackGap);
      c.root.rotation.set(0, 0, (i - (CONFIG.fanCount - 1) / 2) * 0.012);
    });

    if (!gsap) {
      openingCards.forEach((c, i) => {
        const s = fanSlots[i];
        c.root.scale.setScalar(fanScale);
        c.root.position.set(s.x, s.y, s.z);
        c.root.rotation.set(CONFIG.fanLean, 0, s.rotZ);
      });
      openingState = OPENING.FAN;
      return null;
    }

    openingBusy = true;
    openingState = OPENING.FAN;
    const tl = gsap.timeline({
      onComplete: () => { openingBusy = false; openingStartFloat(); },
    });

    openingSyncVisibility();
    openingCards.forEach((c, i) => {
      const s = fanSlots[i];
      if (!s) { c.setOpacity(0); c.root.visible = false; return; }   // 无槽位的多余额外牌彻底隐藏
      const delay = Math.abs(s.t) * CONFIG.fanStagger;   // 中间先动、外侧随后 → 像扇面绽开
      tl.to(c.root.position, { x: s.x, y: s.y, z: s.z, duration: 1.6, ease: 'power3.out' }, delay);
      tl.to(c.root.rotation, { x: CONFIG.fanLean, z: s.rotZ, duration: 1.6, ease: 'power3.out' }, delay);
      tl.to(c.root.scale, { x: fanScale, y: fanScale, z: fanScale, duration: 1.3, ease: 'power2.inOut' }, delay);
    });

    return tl;
  };

  /* 牌背在屏幕上的矩形，用于放置透明点击区（canvas 是 pointer-events:none）。
   * 用牌的实际位置（含漂浮偏移）而不是静态牌位，点击区才始终贴着牌。 */
  api.openingDeckRect = function () {
    if (openingState !== OPENING.DECK || !openingCards.length) return null;
    const root = openingCards[0].root;
    const p = project(root.position);
    const wpx = worldToPixels(deckScale * CARD_W, 0);
    const hpx = worldToPixels(CARD_H * deckScale, 0);
    return { x: p.x - wpx / 2, y: p.y - hpx / 2, w: wpx, h: hpx };
  };

  /* ---------- 渲染循环 ---------- */
  const camState = { z: 5.2, y: 0.35, lookY: 0 };

  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);

    const t = clock.getElapsedTime();

    // 粒子流动
    particles.material.uniforms.uTime.value = t;
    particles.material.uniforms.uPixelRatio.value = dpr;
    if (nebula) {
      nebula.material.uniforms.uTime.value = t * 0.62;
      nebula.material.uniforms.uPixelRatio.value = dpr;
      nebula.rotation.y = t * 0.008;
    }
    particles.rotation.y = t * 0.014;

    // 相机：滚动拉开 + 轻微环绕（环绕由 GSAP 驱动 orbitPhase）
    smoothP += (scrollP - smoothP) * 0.075;
    camState.z = 5.2 + smoothP * 2.9;
    camState.y = 0.35 + smoothP * 0.95;
    camState.lookY = -smoothP * 0.95;

    camera.position.x = Math.sin(orbitPhase) * 0.15;
    camera.position.y = camState.y + Math.sin(orbitPhase * 0.7) * 0.04;
    camera.position.z = camState.z - Math.cos(orbitPhase) * 0.1;
    camera.lookAt(0, camState.lookY, 0);

    stageGroup.position.y = Math.sin(t * 0.5) * 0.03;

    /* 三张牌滚筒：按当前角度摆位（拖动 / 吸附 / 缩放都只改角度与标志位） */
    wheelPlace(t);

    /* 单张牌背：原地轻摆（时间驱动）+ 指针跟随（倾斜 + 位移，柔和插值、无弹簧回弹） */
    if (openingState === OPENING.DECK && openingCards.length) {
      const nowMs = performance.now();
      const dt = tiltLastMs ? Math.min(0.05, (nowMs - tiltLastMs) / 1000) : 1 / 60;
      tiltLastMs = nowMs;
      const a = 1 - Math.pow(1 - CONFIG.deckTiltEase, dt * 60);
      tiltNow.x += (tiltTo.x - tiltNow.x) * a;
      tiltNow.y += (tiltTo.y - tiltNow.y) * a;
      shiftNow.x += (shiftTo.x - shiftNow.x) * a;
      shiftNow.y += (shiftTo.y - shiftNow.y) * a;

      // 轻摆：周期取「往返单程时长 × 2」，即一轮的总时长
      const fx = Math.sin(t * (Math.PI * 2) / (CONFIG.deckFloatDurX * 2)) * CONFIG.deckFloatX;
      const fy = Math.sin(t * (Math.PI * 2) / (CONFIG.deckFloatDurY * 2)) * CONFIG.deckFloatY;

      const c0 = openingCards[0];
      c0.root.position.set(
        deckSlot.x + fx + shiftNow.x,
        deckSlot.y + fy + shiftNow.y,
        deckSlot.z
      );
      c0.root.rotation.x = tiltNow.x;
      c0.root.rotation.y = tiltNow.y;
    }

    /* 输入框雾气：跟随 DOM 位置，淡入淡出由可见度驱动 */
    if (mist) {
      mistAlpha += (mistTarget - mistAlpha) * 0.085;
      if (mistAlpha < 0.004 && mistTarget === 0) {
        mist.visible = false;
      } else if (mistRect) {
        mist.visible = true;
        screenToWorld(mistRect.cx, mistRect.cy, CONFIG.mistZ, mist.position);
        const halfW = pixelsToWorld(mistRect.w * 0.60, CONFIG.mistZ);
        const halfH = pixelsToWorld(mistRect.h * 1.55, CONFIG.mistZ);
        mist.scale.set(halfW, halfH, 0.35);
        mist.material.uniforms.uOpacity.value = mistAlpha * CONFIG.mistOpacity;
        mist.material.uniforms.uTime.value = t;
        mist.material.uniforms.uPixelRatio.value = dpr;
      }
    }

    renderer.render(scene, camera);
  }

  /* ---------- 抽牌入场 + 翻转 ---------- */
  api.reveal = async function (cards, onStage) {
    const gsap = window.gsap;
    // 缓存优先：命中即用，未命中则并行预热（不阻塞后续动画）
    backTexPromise = backTexPromise || loadTexture(BACK_SRC, anisotropy);
    const backTex = texCache[BACK_SRC] || null;
    const faces = cards.map((c) => texCache[c.src] || null);
    cards.forEach((c) => {
      if (!texCache[c.src]) loadTexture(c.src, anisotropy).then((t) => { if (t) texCache[c.src] = t; });
    });

    // 清掉上一轮
    api.clear();

    current = cards.map((c, i) => {
      const card = buildCard(backTex, faces[i], anisotropy);
      if (c.reversed) card.spin.rotation.z = Math.PI;
      card.flying = true;
      card.root.scale.setScalar(cardScale);
      // 起点：空间深处、聚拢、带随机自转
      card.root.position.set(
        (i - 1) * 0.3,
        -0.4 + i * 0.12,
        -9.5 - i * 0.5
      );
      card.root.rotation.set(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 1.4,
        (Math.random() - 0.5) * 0.35
      );
      card.setOpacity(0);
      cardGroup.add(card.root);
      return card;
    });

    /* 未命中缓存的牌面/牌背：图到达后补贴（不阻塞动画） */
    cards.forEach((c, i) => {
      if (faces[i]) return;
      loadTexture(c.src, anisotropy).then((t) => {
        if (!t) return;
        texCache[c.src] = t;
        if (current[i] && current[i].setFaceTex) current[i].setFaceTex(t);
      });
    });
    backTexPromise.then((t) => {
      if (t && current.length) current.forEach((c) => { if (c.setBackTex) c.setBackTex(t); });
    });

    if (!gsap) {
      // 没有 GSAP 也保证可用：直接落到终态
      current.forEach((c, i) => {
        c.flying = false;
        c.root.position.set(slots[i].x, slots[i].y, slots[i].z);
        c.root.rotation.set(0, slots[i].rotY, 0);
        c.flipper.rotation.y = 0;
        c.setOpacity(1);
      });
      return current;
    }

    const tl = gsap.timeline();

    // 1) 浮现 + 飞到各自位置
    current.forEach((c, i) => {
      tl.to(c.root.position, {
        x: slots[i].x, y: slots[i].y, z: slots[i].z,
        duration: 1.15, ease: 'power3.out',
      }, 0.18 * i);
      tl.to(c.root.rotation, {
        x: 0, y: slots[i].rotY, z: 0,
        duration: 1.15, ease: 'power3.out',
      }, 0.18 * i);
    });

    // 淡入（单独控制，避免与位移耦合）
    tl.to({ v: 0 }, {
      v: 1, duration: 0.7, ease: 'power2.out',
      onUpdate: function () {
        const v = this.targets()[0].v;
        current.forEach((c) => c.setOpacity(v));
      },
    }, 0.12);

    // 2) 依次 3D 翻转
    const flipAt = 0.18 * 2 + 1.15 + 0.15;
    current.forEach((c, i) => {
      tl.to(c.flipper.rotation, {
        y: 0, duration: 1.0, ease: 'power2.inOut',
        onComplete: () => { c.flying = false; },
      }, flipAt + 0.24 * i);
    });

    // 3) 翻完后悬浮呼吸
    tl.add(() => {
      if (onStage) onStage();
      current.forEach((c, i) => {
        if (!gsap) return;
        c.floatTween = gsap.to(c.root.position, {
          y: slots[i].y + 0.075,
          duration: 2.7 + i * 0.45,
          yoyo: true, repeat: -1, ease: 'sine.inOut',
          delay: i * 0.22,
        });
      });
      // 相机轻微环绕，不抢戏
      gsap.to({ p: 0 }, {
        p: 1, duration: 22, repeat: -1, ease: 'none',
        onUpdate: function () {
          orbitPhase = this.targets()[0].p * Math.PI * 2;
        },
      });
    }, flipAt + 0.24 * 2 + 1.0);

    return tl;
  };

  api.clear = function () {
    if (current.floatTween) current.forEach((c) => c.floatTween && c.floatTween.kill());
    current.forEach((c) => {
      cardGroup.remove(c.root);
      c.dispose();
    });
    current = [];
  };

  /* ============================================================
   * 抽牌 → 看牌 → 解读：三张牌的生命周期
   *   dealFromFan(cards)    扇形退场 + 三张牌从扇面位置飞到中央（背面朝上）
   *   flipCard(i)           原地绕 Y 轴翻面；逆位牌翻完后绕 Z 轴转 180°
   *   zoomCard(i, on)       原地放大 / 收回（放大时另两张退到后面并变暗）
   *   setView('wheel'|'top') 滚筒 / 三张固定到顶部
   *   cardRect(i)           第 i 张的屏幕矩形（DOM 命中区与文字定位用）
   *   fadeReading(on)       三张牌整体淡出（给"炸成星光"用）
   *   resetReading()        收掉三张
   * ============================================================ */
  let topSlots = [];
  let readingView = 'wheel';
  let zoomed = -1;

  /* ---------- 滚筒 ----------
   * 角度由 app.js 持有并通过 wheelApply() 同步过来（3D 与降级模式共用同一套交互）。
   * 第 i 张牌的相对角 δ = normalize(i·step − angle)：
   *   δ=0    居中（最大、清晰、正对相机）
   *   δ=±120° 在上 / 在下，靠后、缩小、后仰 —— 三张同时可见
   * 摆位在渲染循环里逐帧写入，因此拖动 / 吸附 / 视口变化都自动生效。 */
  let wheelAngle = 0;
  let wheelBusy = 0;        // 飞行 / 视图切换 / 放大收回期间 > 0：滚筒暂不接管摆位
  const wheelTmp = { x: 0, y: 0, z: 0, scale: 1, rotX: 0, cos: 1 };

  function computeWheelSlot(i, out) {
    const { w, h } = size();
    const twoPi = Math.PI * 2;
    let d = (i * CONFIG.wheelStep - wheelAngle) % twoPi;
    if (d > Math.PI) d -= twoPi;
    else if (d < -Math.PI) d += twoPi;
    const s = Math.sin(d);
    const c = Math.cos(d);
    const cardHpx = Math.min(h * CONFIG.wheelHeightRatio, w * 1.62);
    const Rpx = Math.min(w * CONFIG.wheelRadiusXRatio, h * CONFIG.wheelRadiusYMax);
    const xPx = w / 2 + Rpx * s;                          // δ=0 居中；δ>0 在右
    const yPx = h * CONFIG.wheelCenterY + Rpx * CONFIG.wheelArcRatio * Math.abs(s);
    const z = -(1 - Math.max(0, c)) * pixelsToWorld(Rpx, 0) * CONFIG.wheelDepth;
    const p = screenToWorld(xPx, yPx, z, wheelVec);
    out.x = p.x;
    out.y = p.y;
    out.z = z;
    out.scale = (pixelsToWorld(cardHpx, 0) / CARD_H)
      * (CONFIG.wheelMinScale + (1 - CONFIG.wheelMinScale) * Math.max(0, c));
    out.rotY = -CONFIG.wheelTiltAmp * s;                // 侧牌朝中心倾转（coverflow）
    out.rotX = 0;
    out.cos = c;
    return out;
  }

  const wheelVec = new THREE.Vector3();
  const wheelSlotTmps = [ {}, {}, {} ];
  let wheelLastOp = [ -1, -1, -1 ];

  /* 渲染循环里的滚筒摆位（放大 / 飞行 / 顶部视图时不接管） */
  function wheelPlace(t) {
    /* 滚筒/牌行显示模式（'wheel' 或 'row' 都按滚轮槽位渲染）；
     * 仅顶部固定视图（'top'，即解读态）不接管摆位。 */
    if (!current.length || readingView === 'top' || zoomed >= 0 || wheelBusy > 0) return;
    for (let i = 0; i < current.length; i++) {
      const c = current[i];
      if (!c || c.flying) continue;
      const sl = computeWheelSlot(i, wheelSlotTmps[i]);
      c.root.position.set(sl.x, sl.y + Math.sin(t * 0.6 + i * 2.1) * CONFIG.wheelBob, sl.z);
      c.root.rotation.set(sl.rotX, sl.rotY, 0);
      c.root.scale.setScalar(sl.scale);
      const op = CONFIG.wheelDim + (1 - CONFIG.wheelDim) * Math.max(0, sl.cos);
      if (Math.abs(op - wheelLastOp[i]) > 0.01) {
        c.setOpacity(op);
        wheelLastOp[i] = op;
      }
    }
  }

  /* app.js 每帧同步滚筒角度 */
  api.wheelApply = function (a) { wheelAngle = a || 0; };

  function stopRowFloat() {
    current.forEach((c) => { if (c.floatTween) { c.floatTween.kill(); c.floatTween = null; } });
  }

  /* ============================================================
   * 漩涡退场（抽牌动画第一~三段的连续几何）：
   *   ① 扇形各牌绕圆心公转、向中心聚拢，收成一个圆（圆心同时从页面上方
   *      落到屏幕内上部，保证圆可见）；
   *   ② 圆整体向圆心收缩，旋转加速，牌在圆心缩小淡出消失；
   *   ③ 三张牌从「消失点」出现：由小变大、边飞边散开，落到滚筒槽位
   *      （落位轻微弹性 back.out）。
   * 前一段终点 = 后一段起点：消失点 = 飞出起点，无生硬切换。
   * 返回 { tl, origin, appearAt }：tl 已含①②，飞出段由 dealFromFan
   * 续进同一条 timeline（appearAt = 三张牌出现的绝对时刻）。
   * ============================================================ */
  function fanVortexExit(speed) {
    const gsap = window.gsap;
    const { w, h } = size();
    const cx = w / 2;
    const cyEnd = h * 0.30;                              // 吸入消失点（屏幕上部）
    const ringR = Math.min(fanCardWpx * 1.7, h * 0.26);  // 聚圆半径（屏幕像素）
    const durA = 0.95 * speed;                           // ① 聚拢成圆
    const durB = 0.62 * speed;                           // ② 吸入消失
    const zPlane = -0.15;
    const origin = screenToWorld(cx, cyEnd, zPlane, new THREE.Vector3());

    openingState = OPENING.EXIT;
    openingStopFloat();
    tiltReset();

    const st = { cy: pivotScreen.y };
    /* 每张牌一个代理：角度 th（0=正下方，顺时针正）、半径 r、朝向、深度 */
    const visN = fanSlots.length;
    const per = openingCards.map((c, i) => {
      const s = fanSlots[i];
      if (!s) return { c, on: false };
      const p = project(c.root.position);                // 当前屏幕像素
      const dx = p.x - pivotScreen.x;
      const dy = p.y - pivotScreen.y;
      const th0 = Math.atan2(dx, Math.max(1, dy));
      /* 目标：整圆均匀分布 + 额外公转 0.75 圈（取最近等价角，不绕远路） */
      const uni = (i % Math.max(1, visN)) * (Math.PI * 2 / Math.max(1, visN)) + Math.PI;
      const base = uni + Math.PI * 2 * 0.75;
      const thA = base + Math.PI * 2 * Math.round((th0 - base) / (Math.PI * 2));
      return {
        c, on: true,
        th: th0, r: Math.max(1, Math.hypot(dx, dy)),
        lean: CONFIG.fanLean, spin: 0,
        thA, r0: Math.max(1, Math.hypot(dx, dy)),
      };
    });

    const place = () => {
      per.forEach((o) => {
        if (!o.on) return;
        const wx = screenToWorld(cx + Math.sin(o.th) * o.r, st.cy + Math.cos(o.th) * o.r, zPlane, wheelVec);
        o.c.root.position.set(wx.x, wx.y, zPlane);
        /* 长轴沿切线（-o.th）叠加自身自旋（spin）→ 螺旋退场观感 */
        o.c.root.rotation.set(o.lean, 0, -o.th + o.spin);
      });
    };

    const tl = gsap.timeline({
      onComplete: () => {
        openingCards.forEach((c) => { c.root.visible = false; c.setOpacity(0); });
      },
    });

    /* ① 聚拢成圆：圆心落到屏内、半径收到 ringR、角度均匀化 + 公转 */
    tl.to(st, { cy: cyEnd, duration: durA, ease: 'power2.inOut', onUpdate: place }, 0);
    per.forEach((o) => {
      if (!o.on) { o.c.root.visible = false; o.c.setOpacity(0); return; }
      tl.to(o, { th: o.thA, duration: durA, ease: 'power2.inOut' }, 0);
      tl.to(o, { r: ringR, duration: durA, ease: 'power2.inOut' }, 0);
      tl.to(o, { lean: 0, duration: durA, ease: 'power2.inOut' }, 0);
      tl.to(o.c.root.scale, {
        x: fanScale * 0.82, y: fanScale * 0.82, z: fanScale * 0.82,
        duration: durA, ease: 'power2.inOut',
      }, 0);
    });

    /* ② 螺旋吸入：半径收缩 → 牌一边公转加速、一边绕自身 Z 轴自旋，旋转缩小退场。
     * 关键是"转着缩没"，而不是单纯缩没——牌面角度持续变化制造螺旋感。 */
    per.forEach((o, i) => {
      if (!o.on) return;
      const spinDir = (i % 2 === 0) ? 1 : -1;             // 相邻牌反向自旋，漩涡更碎更亮
      tl.to(o, { th: o.thA + Math.PI * 2 * 1.35 * spinDir, duration: durB, ease: 'power3.in' }, durA);
      tl.to(o, { r: 0, duration: durB, ease: 'power3.in' }, durA);
      /* 自旋：绕卡片法线（Z）转 1.25 圈，与公转叠加 = 螺旋退场 */
      tl.to(o, { spin: Math.PI * 2 * 1.25 * spinDir, duration: durB, ease: 'power2.in', onUpdate: place }, durA);
      tl.to(o.c.root.scale, {
        x: 0.001, y: 0.001, z: 0.001, duration: durB, ease: 'power2.in',
      }, durA);
      tl.to({ v: 1 }, {
        v: 0, duration: durB * 0.46, ease: 'power2.in', delay: durB * 0.5,
        onUpdate: function () { o.c.setOpacity(this.targets()[0].v); },
      }, durA);
    });

    return { tl, origin, appearAt: durA + durB, cycle: durA + durB };
  }

  /* 抽牌：扇形漩涡退场（聚圆→吸入→消失），三张牌从消失点飞向滚筒（背面朝上）。
   * opts.fromDeck  起点改用单张牌背的位置（历史回看进入时用，那时没有扇形）
   * opts.quick     0.6 倍时长（历史进入的过渡要快）
   * 返回 Promise，动画全部落位后 resolve。 */
  api.dealFromFan = async function (cards, opts) {
    const o = opts || {};
    const speed = o.quick ? 0.6 : 1;
    const gsap = window.gsap;

    /* 关键：贴图加载不再阻塞动画。弱网下 loadTexture 最坏要等十几秒，
     * 若在动画前 await，用户会看到"卡住→过一会才播"。改为并行预热：
     * 立刻用已缓存的贴图（没有就先建纯色牌）开播，贴图到达后 setFaceTex 补贴。 */
    backTexPromise = backTexPromise || loadTexture(BACK_SRC, anisotropy);
    const backTex = texCache[BACK_SRC] || null;
    const faces = cards.map((c) => texCache[c.src] || null);
    cards.forEach((c) => {
      if (!texCache[c.src]) {
        loadTexture(c.src, anisotropy).then((tex) => {
          if (tex) texCache[c.src] = tex;
        });
      }
    });

    api.clear();
    stopRowFloat();
    zoomed = -1;
    wheelLastOp = [-1, -1, -1];
    readingView = 'wheel';

    /* 1) 扇形漩涡退场（无 GSAP / 减弱动效 / 历史路径 → 原地缩小淡出兜底） */
    const vortexOk = !o.fromDeck && openingState === OPENING.FAN
      && openingGroup && openingCards.length && !!gsap && !REDUCED;
    if (openingState === OPENING.FAN && !vortexOk) {
      openingState = OPENING.EXIT;
      openingCards.forEach((c, i) => {
        if (!gsap) { c.setOpacity(0); c.root.visible = false; return; }
        const d = 0.05 * Math.abs(i - (openingCards.length - 1) / 2) * speed;
        gsap.to(c.root.rotation, { z: (c.root.rotation.z || 0) + (i % 2 ? 0.55 : -0.55), duration: 1.05 * speed, ease: 'power2.in', delay: d });
        gsap.to(c.root.scale, { x: 0.0001, y: 0.0001, z: 0.0001, duration: 0.95 * speed, ease: 'power2.in', delay: d });
        gsap.to({ v: 1 }, {
          v: 0, duration: 0.9 * speed, ease: 'power2.in', delay: d,
          onUpdate: function () { c.setOpacity(this.targets()[0].v); },
        });
      });
    }
    let vortex = null;
    if (vortexOk) vortex = fanVortexExit(speed);

    /* 2) 三张牌：起点 = 漩涡消失点（极小 + 带旋转）→ 旋转放大飞出，终点 = 滚筒槽位 */
    const turn = o.quick ? 0.5 : CONFIG.dealSpin * 0.5;
    const startPx = Math.max(26, size().h * 0.075);      // 飞出起始牌高（由小变大）

    current = cards.map((c, i) => {
      const card = buildCard(backTex, faces[i], anisotropy);
      card.reversed = !!c.reversed;
      card.flipped = false;
      let s0;
      if (o.fromDeck) {
        s0 = { x: deckSlot.x + (i - 1) * pixelsToWorld(30, 0), y: deckSlot.y, z: deckSlot.z, scale: deckScale, rotZ: (i - 1) * 0.14 };
      } else if (vortex) {
        /* 起点与漩涡终点严格对齐：极小尺寸 + 各自自旋角，飞出时"由旋转到正" */
        s0 = {
          x: vortex.origin.x + (i - 1) * pixelsToWorld(10, 0),
          y: vortex.origin.y,
          z: vortex.origin.z,
          scale: 0.001,                                   // 从消失点"无"中长出
          rotZ: (i % 2 === 0 ? 1 : -1) * Math.PI * 1.15,  // 起始自旋 1.15 圈
        };
      } else {
        const n = fanSlots.length || 1;
        const mid = Math.floor(n / 2);
        const src = [mid - 1, mid, mid + 1].map((k) => fanSlots[Math.max(0, Math.min(n - 1, k))]);
        const ss = src[i] || { x: 0, y: 0, z: 0, rotZ: 0, scale: fanScale || cardScale };
        s0 = { x: ss.x, y: ss.y, z: ss.z, scale: ss.scale, rotZ: ss.rotZ || 0 };
      }
      card.root.scale.setScalar(s0.scale || cardScale);
      card.root.position.set(s0.x, s0.y, s0.z);
      card.root.rotation.set(CONFIG.fanLean, -Math.PI * 2 * turn, s0.rotZ || 0);
      card.setOpacity(0);
      cardGroup.add(card.root);

      if (!gsap) {
        const t = computeWheelSlot(i, wheelSlotTmps[i]);
        card.root.scale.setScalar(t.scale);
        card.root.position.set(t.x, t.y, t.z);
        card.root.rotation.set(t.rotX, t.rotY || 0, 0);
        card.setOpacity(CONFIG.wheelDim + (1 - CONFIG.wheelDim) * Math.max(0, t.cos));
        wheelLastOp[i] = -1;
      }
      return card;
    });

    /* 未命中缓存的牌面：图一旦到达就补贴到牌面（不阻塞动画） */
    cards.forEach((c, i) => {
      if (faces[i]) return;
      loadTexture(c.src, anisotropy).then((tex) => {
        if (!tex) return;
        texCache[c.src] = tex;
        if (current[i] && current[i].setFaceTex) current[i].setFaceTex(tex);
      });
    });
    /* 牌背同理：先给纯色，图到了自动补贴 */
    backTexPromise.then((tex) => {
      if (tex && current.length) current.forEach((c) => { if (c.setBackTex) c.setBackTex(tex); });
    });

    /* 目标：滚筒槽位（角度已由 app.js 归零 → 第 0 张居中） */
    const targets = [0, 1, 2].map((i) => {
      const t = {};
      computeWheelSlot(i, t);
      return t;
    });

    if (!gsap) { wheelBusy = 0; return Promise.resolve(current); }
    wheelBusy++;

    /* 主 timeline：漩涡退场在前，飞出段续在消失点时刻之后 */
    const tl = vortex ? vortex.tl : gsap.timeline();
    const flyAt = vortex ? vortex.appearAt : 0.24 * speed;

    /* 逐张快速淡入到目标不透明度（初期极短，因为可见度主要由 scale 承担） */
    current.forEach((c, i) => {
      const tOp = CONFIG.wheelDim + (1 - CONFIG.wheelDim) * Math.max(0, targets[i].cos);
      tl.to({ v: 0 }, {
        v: tOp, duration: 0.28 * speed, ease: 'power1.out',
        onUpdate: function () { c.setOpacity(this.targets()[0].v); },
      }, flyAt + 0.03 * speed * i);
    });

    current.forEach((c, i) => {
      const s = targets[i];
      const at = flyAt + 0.1 * speed * i;
      /* 旋转放大飞出：位置由消失点飞到滚筒槽（back 轻微过冲 = 落位弹性），
       * 旋转从起始自旋回到正视（power3 由快转慢），scale 由"无"放大到目标。 */
      tl.to(c.root.position, { x: s.x, y: s.y, z: s.z, duration: 1.25 * speed, ease: 'back.out(1.15)' }, at);
      tl.to(c.root.rotation, {
        x: s.rotX, y: s.rotY || 0, z: 0,
        duration: 1.2 * speed, ease: 'power3.out',
      }, at);
      tl.to(c.root.scale, {
        x: s.scale, y: s.scale, z: s.scale,
        duration: 1.15 * speed, ease: 'back.out(1.3)',
      }, at);
    });

    return new Promise((res) => {
      tl.eventCallback('onComplete', () => {
        current.forEach((c) => { c.flying = false; });
        wheelBusy = Math.max(0, wheelBusy - 1);
        res(current);
      });
    });
  };

  /* 翻牌：绕 Y 轴 180°；逆位牌翻完后绕 Z 轴再转 180° */
  api.flipCard = function (i) {
    const c = current[i];
    if (!c || c.flipped) return null;
    c.flipped = true;
    const gsap = window.gsap;
    if (!gsap) {
      c.flipper.rotation.y = 0;
      if (c.reversed) c.spin.rotation.z = Math.PI;
      return null;
    }
    const tl = gsap.timeline();
    tl.to(c.flipper.rotation, { y: 0, duration: 1.0, ease: 'power2.inOut' });
    if (c.reversed) tl.to(c.spin.rotation, { z: Math.PI, duration: 0.6, ease: 'power2.inOut' }, '>-0.08');
    return tl;
  };

  /* 直接置为"已翻开"（历史回看时用，不做动画） */
  api.presetFlipped = function (i) {
    const c = current[i];
    if (!c) return;
    c.flipped = true;
    c.flipper.rotation.y = 0;
    c.spin.rotation.z = c.reversed ? Math.PI : 0;
  };

  /* 放大 / 收回（从滚筒放大，收回时回到当前角度下的滚筒槽位） */
  api.zoomCard = function (i, on) {
    const gsap = window.gsap;
    const c = current[i];
    if (!c) return null;
    const { w, h } = size();
    const zPlane = 0;

    const wheelTarget = (j) => {
      const t = {};
      computeWheelSlot(j, t);
      return t;
    };

    if (!gsap) {
      if (on) {
        const targetH = Math.min(h * CONFIG.zoomHeightRatio, w * 1.529);
        const s = targetH / worldToPixels(CARD_H, zPlane);
        const p = screenToWorld(w / 2, h * CONFIG.zoomCenterY, zPlane, new THREE.Vector3());
        c.root.scale.setScalar(s);
        c.root.position.set(p.x, p.y, zPlane);
        c.root.rotation.set(0, 0, 0);
        zoomed = i;
      } else {
        current.forEach((o, j) => {
          const t = wheelTarget(j);
          o.root.scale.setScalar(t.scale);
          o.root.position.set(t.x, t.y, t.z);
          o.root.rotation.set(t.rotX, t.rotY || 0, 0);
          o.setOpacity(CONFIG.wheelDim + (1 - CONFIG.wheelDim) * Math.max(0, t.cos));
        });
        wheelLastOp = [-1, -1, -1];
        zoomed = -1;
      }
      return null;
    }

    stopRowFloat();
    const tl = gsap.timeline();

    if (on) {
      zoomed = i;                       // 先置放大态：滚筒摆位随即让位
      const targetH = Math.min(h * CONFIG.zoomHeightRatio, w * 1.529);
      const s = targetH / worldToPixels(CARD_H, zPlane);
      const p = screenToWorld(w / 2, h * CONFIG.zoomCenterY, zPlane, new THREE.Vector3());
      tl.to(c.root.scale, { x: s, y: s, z: s, duration: 0.9, ease: 'power3.inOut' }, 0);
      tl.to(c.root.position, { x: p.x, y: p.y, z: zPlane, duration: 0.9, ease: 'power3.inOut' }, 0);
      tl.to(c.root.rotation, { x: 0, y: 0, z: 0, duration: 0.9, ease: 'power3.inOut' }, 0);
      // 另两张退到后面并隐去（放大态下不参与滚筒摆位）
      current.forEach((o, j) => {
        if (j === i) return;
        tl.to(o.root.position, { z: -1.8, duration: 0.8, ease: 'power2.inOut' }, 0);
        tl.to({ v: o.materials[0].opacity }, {
          v: 0.05, duration: 0.7,
          onUpdate: function () { o.setOpacity(this.targets()[0].v); },
        }, 0);
      });
    } else {
      current.forEach((o, j) => {
        const t = wheelTarget(j);
        tl.to(o.root.scale, { x: t.scale, y: t.scale, z: t.scale, duration: 0.85, ease: 'power3.inOut' }, 0.05 * j);
        tl.to(o.root.position, { x: t.x, y: t.y, z: t.z, duration: 0.85, ease: 'power3.inOut' }, 0.05 * j);
        tl.to(o.root.rotation, { x: t.rotX, y: t.rotY || 0, z: 0, duration: 0.85, ease: 'power3.inOut' }, 0.05 * j);
        tl.to({ v: o.materials[0].opacity }, {
          v: CONFIG.wheelDim + (1 - CONFIG.wheelDim) * Math.max(0, t.cos),
          duration: 0.5,
          onUpdate: function () { o.setOpacity(this.targets()[0].v); },
        }, 0);
      });
      tl.add(() => {
        wheelLastOp = [-1, -1, -1];
        zoomed = -1;                    // 落位完成后才把滚筒摆位交回去
      });
    }
    return tl;
  };

  /* 三张牌在「滚筒」与「固定到顶部」之间切换 */
  api.setView = function (mode) {
    const gsap = window.gsap;
    if (!current.length) { readingView = mode; return null; }
    if (mode === 'top') computeTopSlots();      // 用当前视口重算，保证贴顶
    stopRowFloat();
    if (!gsap) {
      current.forEach((c, i) => {
        const s = mode === 'top' ? topSlots[i] : computeWheelSlot(i, wheelSlotTmps[i]);
        c.root.scale.setScalar(s.scale);
        c.root.position.set(s.x, s.y, s.z);
        c.root.rotation.set(mode === 'top' ? 0 : s.rotX, mode === 'top' ? s.rotY : (s.rotY || 0), 0);
      });
      readingView = mode;
      wheelLastOp = [-1, -1, -1];
      return null;
    }
    wheelBusy++;
    const tl = gsap.timeline({
      onComplete: () => {
        readingView = mode;
        wheelLastOp = [-1, -1, -1];
        wheelBusy = Math.max(0, wheelBusy - 1);
      },
    });
    current.forEach((c, i) => {
      const s = mode === 'top' ? topSlots[i] : computeWheelSlot(i, wheelSlotTmps[i]);
      tl.to(c.root.position, { x: s.x, y: s.y, z: s.z, duration: 0.95, ease: 'power3.inOut' }, 0.05 * i);
      tl.to(c.root.scale, { x: s.scale, y: s.scale, z: s.scale, duration: 0.95, ease: 'power3.inOut' }, 0.05 * i);
      tl.to(c.root.rotation, {
        x: mode === 'top' ? 0 : s.rotX,
        y: mode === 'top' ? s.rotY : (s.rotY || 0),
        z: 0, duration: 0.95, ease: 'power3.inOut',
      }, 0.05 * i);
    });
    return tl;
  };

  api.getView = () => readingView;
  api.getZoomed = () => zoomed;

  /* 第 i 张牌的屏幕矩形（含当前缩放/位移） */
  api.cardRect = function (i) {
    const c = current[i];
    if (!c) return null;
    const p = project(c.root.position);
    const sc = c.root.scale.x;
    const wpx = worldToPixels(CARD_W * sc, c.root.position.z);
    const hpx = worldToPixels(CARD_H * sc, c.root.position.z);
    return { x: p.x - wpx / 2, y: p.y - hpx / 2, w: wpx, h: hpx };
  };

  /* 三张牌整体淡出（"炸成星光"前先把实体收掉） */
  api.fadeReading = function (on) {
    const gsap = window.gsap;
    stopRowFloat();
    if (!gsap) { current.forEach((c) => c.setOpacity(on ? 0 : 1)); return null; }
    return gsap.to({ v: on ? 1 : 0 }, {
      v: on ? 0 : 1, duration: 0.6, ease: 'power2.out',
      onUpdate: function () { current.forEach((c) => c.setOpacity(this.targets()[0].v)); },
    });
  };

  api.resetReading = function () {
    stopRowFloat();
    api.clear();
    readingView = 'wheel';
    zoomed = -1;
    wheelBusy = 0;
    wheelLastOp = [-1, -1, -1];
  };

  api.setScrollProgress = function (p) {
    scrollP = Math.max(0, Math.min(1, p || 0));
  };

  api.resize = function () {
    layout();
    // 滚筒视图的摆位逐帧重算，无需处理；只有顶部视图需要按新尺寸复位
    if (current.length && readingView === 'top') {
      current.forEach((c, i) => {
        if (i === zoomed) return;
        const s = topSlots[i];
        if (!s) return;
        c.root.scale.setScalar(s.scale);
        c.root.position.set(s.x, s.y, s.z);
        c.root.rotation.set(0, s.rotY, 0);
      });
    }
    if (!openingGroup || openingBusy) return;
    // 屏幕坐标反算世界坐标，所以尺寸变化后必须重算并复位
    const wasFloating = openingState === OPENING.FAN;
    openingStopFloat();
    openingLayout();

    if (openingState === OPENING.FAN) {
      openingCards.forEach((c, i) => {
        const s = fanSlots[i];
        if (!s) return;
        c.root.scale.setScalar(fanScale);
        c.root.position.set(s.x, s.y, s.z);
        c.root.rotation.set(CONFIG.fanLean, 0, s.rotZ);
      });
      if (wasFloating) openingStartFloat();
    } else if (openingState === OPENING.DECK && openingCards[0]) {
      openingCards[0].root.scale.setScalar(deckScale);
      openingCards[0].root.position.set(deckSlot.x, deckSlot.y, deckSlot.z);
      // 单张牌用「原地轻摆」，不能用扇形那套（否则会漂到扇形的槽位上）
      if (openingCards[0].root.visible) openingFloatDeck();
    }
  };

  api.dispose = function () {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('pointerdown', onTiltDown);
    window.removeEventListener('pointermove', onTiltMove);
    window.removeEventListener('pointerup', tiltReset);
    window.removeEventListener('pointercancel', tiltReset);
    window.removeEventListener('blur', tiltReset);
    openingStopFloat();
    openingCards.forEach((c) => c.dispose());
    openingCards = [];
    api.clear();
    renderer.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };

  /* ---------- 启动 ---------- */
  clock = new THREE.Clock();
  layout();
  api.ok = true;
  api.ready = true;
  tick();

  return api;
}
