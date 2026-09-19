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
  particleCount: 30000,    // 粒子数（需求默认值）
  nebulaCount: 70,         // 星云柔光团数量
  dprMax: 2,               // 设备像素比上限
  enableNebula: true,
  enableFog: true,
  autoDegrade: false,      // 明确关闭：不做性能自动降级
  fov: 42,
  cardDepth: 0.03,
  textureAnisotropyMax: 4,
};

/* 降级档位建议值（供以后启用 autoDegrade 时使用，当前不自动应用） */
export const DEGRADE_PROFILES = {
  high: { particleCount: 30000, dprMax: 2, enableNebula: true },
  medium: { particleCount: 14000, dprMax: 1.5, enableNebula: true },
  low: { particleCount: 6000, dprMax: 1, enableNebula: false },
};

const CARD_W = 1;
const CARD_H = 1 / 0.5625;          // 牌面素材为 1080×1920，宽高比 9:16
const COLOR_GOLD = 0xc9a961;
const COLOR_INK = 0x0a0908;

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
  varying vec3 vTint;
  varying float vAlpha;

  void main() {
    vTint = aTint;

    // 缓慢流动：三轴用不同频率/相位，避免看出规律
    vec3 p = position;
    float t = uTime * 0.055;
    p.x += sin(t + aPhase) * 0.62;
    p.y += cos(t * 0.82 + aPhase * 1.31) * 0.55;
    p.z += sin(t * 0.63 + aPhase * 0.71) * 0.42;

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
  varying vec3 vTint;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = smoothstep(0.5, 0.04, d);
    float glow = pow(core, 3.2);
    float a = (core * 0.32 + glow * 0.9) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vTint, a);
  }
`;

function makeParticleMaterial(uSize, uOpacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSize: { value: uSize },
      uOpacity: { value: uOpacity },
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

/* ============================================================
 * 3D 卡牌（Layer 1）
 * ============================================================ */

const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');

function loadTexture(url, anisotropy) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = anisotropy;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        resolve(tex);
      },
      undefined,
      () => resolve(null)   // 贴图缺失时不阻塞，退回纯色牌面
    );
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
      makeParticleMaterial(30, 0.062)
    );
    nebula.frustumCulled = false;
    scene.add(nebula);
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
  function layout() {
    const { w, h } = size();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;

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
    const wByHeight = (visH * 0.56) / CARD_H;
    const cardW = Math.max(0.34, Math.min(wByWidth, wByHeight));
    cardScale = cardW;                                      // CARD_W 恒为 1
    const spread = cardW * (1 + gapRatio);                   // 保证不重叠

    slots = [
      { x: -spread, y: 0, z: -zOff, rotY: 0.07 },   // 过去：稍远
      { x: 0, y: 0, z: 0, rotY: 0 },                // 现在：居中
      { x: spread, y: 0, z: zOff, rotY: -0.07 },    // 未来：稍近
    ];

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
    return project(slots[i], -(CARD_H * cardScale) / 2 - 0.16).y;
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

    renderer.render(scene, camera);
  }

  /* ---------- 抽牌入场 + 翻转 ---------- */
  api.reveal = async function (cards, onStage) {
    const gsap = window.gsap;
    const backTex = await loadTexture('cards/back.jpg', anisotropy);

    // 三张牌面并行加载
    const faces = await Promise.all(
      cards.map((c) => loadTexture(c.src, anisotropy))
    );

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

  api.setScrollProgress = function (p) {
    scrollP = Math.max(0, Math.min(1, p || 0));
  };

  api.resize = function () { layout(); };

  api.dispose = function () {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
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
