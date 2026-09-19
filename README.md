# 穆夏塔罗 · Mucha Tarot

在线塔罗抽牌站：**过去 / 现在 / 未来** 三张牌，内置 78 张公版牌义，可选 AI 深度解读，无需登录。

- 3D 沉浸式牌阵（Three.js 单场景三层）+ 奢侈品式配色
- 开场交互：屏幕中央单张牌背 → 点击展开成扇形（圆心在页面顶部，牌向下方辐射）+ 标题炸成星光
  → 扇面下方依次淡入神秘问句 / 无框输入框 / 传统提示 / 泛涟漪光圈
- 顶部光球展示（最多 3 个，对应最近几次抽牌；本批次只做静态展示 + 最旧那颗呼吸）
- 花体英文标题（Cinzel Decorative）
- 零构建、不引入框架；Three.js / GSAP / 字体走 CDN，牌面与数据本地打包
- AI 解读走 Cloudflare Pages Function，Key 只从环境变量读取
- **不存储任何用户数据**：无 localStorage、无历史记录，抽牌与提问都不落盘
- 纯娱乐用途

线上地址：<https://tarot-mucha.pages.dev>

## 目录结构

```
MuchaTarot/
├── index.html                入口页
├── css/
│   └── style.css             设计令牌 + 全部样式
├── js/
│   ├── data.js               78 张牌面映射（id / 文件名 / 牌名 / 花色）
│   ├── scene.js              Three.js 统一 3D 场景（粒子星云 / 仪式舞台 / 3D 卡牌）
│   └── app.js                开场状态机、光球、抽牌、渲染、GSAP 编排、AI 调用
├── data/
│   └── meanings.js           78 张牌义（正位 / 逆位 / 关键词）
├── functions/
│   └── api/
│       └── tarot.js          Pages Function：POST /api/tarot → 智谱 GLM
├── cards/                    78 张牌面 JPG + back.jpg（牌背）+ favicon.png
├── pictrues/                 原始素材（已 gitignore，不入库不部署）
└── README.md
```

## 本地运行

需要能跑 Pages Function（AI 解读），用 wrangler：

```bash
npm install wrangler
npx wrangler pages dev . --port 8788 --binding GLM_API_KEY=你的key
```

打开 <http://localhost:8788>。

> 只看 3D 与抽牌、不需要 AI 的话，任意静态服务器都可以（`python -m http.server 8080`）；
> 此时 `/api/tarot` 会 404，AI 面板会给出友好错误提示，其余功能不受影响。

## 3D 场景架构

**一个 Three.js 场景渲染三层**，不是三个 canvas。相机运动同时作用于三层，产生真实空间感。

| 层 | 内容 | 实现 |
| --- | --- | --- |
| Layer 3（最远） | 粒子星云 | `THREE.Points` + 自定义 `ShaderMaterial`，默认 **30000** 粒子；顶点着色器内做三轴错频漂移 + 呼吸，片元用软圆点 + Additive 混合；另有一层少量大尺寸柔光团营造星云感 |
| Layer 2（中间） | 仪式舞台 | 地面柔光盘（canvas 生成的径向渐变贴图）+ 两圈极淡金环，锚定"仪式空间" |
| Layer 1（最近） | 3D 卡牌 | 牌体 `BoxGeometry` 有厚度 + 正/背两张平面贴图（背图绕 Y 轴 180° 避免镜像）+ `EdgesGeometry` 细金描边 |
| 附着层 | 输入框粒子雾 | 与卡牌同一个场景；app.js 每帧把输入框的屏幕矩形传给场景，场景用视线与 `z = CONFIG.mistZ` 平面求交得到世界坐标，整团粒子随之平移，因此滚动、横竖屏、移动端键盘弹起都能跟住。约六成粒子走外圈光环、四成是框内极淡薄雾，文字区域保持干净 |

- 光影：环境光 + 一盏主光 + 一盏金色轮廓光 + 一点暖色补光；`ACESFilmicToneMapping`
- 纵深：三张牌 z 轴错开（过去稍远 / 现在居中 / 未来稍近），透视自然产生大小差
- 开场扇形：**圆心在页面顶部的正中竖线上**（实际落在顶边之上，由几何反算），牌沿半径向下方辐射 ——
  外侧牌更高、中间牌最低，故轮廓是「向下鼓」的穹形，而不是手持扇那种向上鼓的弧形。
  各牌的 `rotation.z = a`（长轴沿半径），因此每张牌都指向圆心
- 尺寸自适应：牌宽同时受「三张牌 + 间隙放进 92% 视宽」与「不超过 56% 视高」约束，窄屏自动缩小，不会溢出
- 牌位标签是 `position: fixed` 的 DOM 浮层，每帧按 3D 投影（`Vector3.project`）定位，因此滚动时也与卡牌保持对齐
- 相机：滚动用 `ScrollTrigger` 映射为向后拉开；同时有一条 22 秒的极轻微环绕，不抢戏

### 降级与开关

`js/scene.js` 顶部集中了配置：

```js
export const CONFIG = {
  enable3D: true,          // 总开关
  particleCount: 30000,    // 星云粒子数
  nebulaCount: 70,
  dprMax: 2,
  enableNebula: true,
  autoDegrade: false,      // 按需求：不做性能自动降级
  fov: 42,
  cardDepth: 0.03,

  /* 开场扇形 */
  enableOpening: true,
  fanCount: 9,             // 宽屏张数
  fanCountNarrow: 8,       // 窄屏张数
  fanGapRatio: 0.75,       // 相邻牌中心距 = 牌宽 × 该比例
  fanMaxAngle: 0.85,       // 最外侧牌偏角（约 49°）→ 决定穹形深浅
  fanTopRatio: 0.075,      // 扇形最上沿（占视口高度）
  fanBandRatio: 0.32,      // 扇形所在竖直带
  fanStagger: 0.30, fanFloat: 0.075, fanLean: -0.10,
};

/* 输入框粒子雾：开场改成居中无框输入后已关闭，实现保留（enableMist 改回 true 即恢复） */
export const DEGRADE_PROFILES = { high: {...}, medium: {...}, low: {...} };
```

- 未开启自动降级（尊重需求），但 `DEGRADE_PROFILES` 已备好三档参数，改 `CONFIG` 即可启用
- 检测不到 WebGL 时不崩溃：显示友好提示，并切换到 `body.no-3d` 简洁模式——开场、光球、抽牌、牌义、AI 全部照常，点牌背用牌背图片顶替

## 配色与字体

| 用途 | 值 |
| --- | --- |
| 背景 | `#0A0908` / `#12100E` / `#17140F` |
| 主文字（象牙） | `#EDE8E0` |
| 强调（香槟金） | `#C9A961` |
| 次要文字（灰米） | `#8A8278` |
| 更弱文字 | `#5F594F` |
| 边框 | `rgba(201,169,97,0.2)` / `rgba(237,232,224,0.08)` |
| 面板 | `rgba(18,16,14,0.88)` + `backdrop-filter: blur(9px)` |

全部以 CSS 变量定义在 `:root`。
- 标题：`Cinzel Decorative`（花体英文，Google Fonts CDN），单行 `Tarot`，`background-clip: text` 上金色渐变
- 其余拉丁字形：`Cormorant Garamond`
- 中文与正文：系统栈

section 间距 104px（窄屏 76px）。**页面上不出现任何说明性文字**。首屏只有：顶部光球、标题 `Tarot`、
神秘问句 `Whisper your question…`、无框输入框（**无 placeholder**、居中、香槟金光标）、
传统提示两行 `Ask once, ask true. / Ask twice, the cards lie.`、泛涟漪光圈。

## 动效清单

| # | 动效 | 实现 |
| --- | --- | --- |
| 1 | 首屏：光球 + 标题淡入，单张牌背在屏幕中央浮现 | GSAP `fromTo`（标题）、`renderOrbs()` 内 `fromTo`（光球）、缩放 + 透明度 tween（牌） |
| 2 | 点击牌背：单张 → 9 张扇形展开 | GSAP timeline；偏离中心越远出发越晚（`|t| × 0.30s`）→ 像扇面绽开；1.6s `power3.out`；落位后各自呼吸悬浮（周期 3.0–4.7s，延迟错开） |
| 3 | 标题炸成星光并消失 | canvas 采样字形像素 → DOM 光点 → GSAP 飞散（见下） |
| 4 | 问句 → 输入框 → 提示 → 光圈依次淡入上移 | GSAP `fromTo` + `stagger: 0.16`，延迟 0.8s |
| 5 | 光圈涟漪扩散 | CSS `@keyframes ringWave` 4.6s，三层错开 0 / 1.5 / 3.0s |
| 6 | 最旧光球缓慢呼吸 | CSS `@keyframes orbAging` 4.6s ease-in-out infinite |
| 7 | 抽牌：从空间深处浮现 → 飞到三位 → 依次 3D 翻转 | GSAP timeline（后续批次接入口） |
| 8 | 牌义 / 结果区滚动触发 | `ScrollTrigger` |
| 9 | 按钮 hover：金色微光流动 | CSS `::after` 渐变扫过 |

未做（按需求）：滚动劫持、音效、粒子爆炸、镜头剧烈运动。

### 标题炸成星光

1. 等 `document.fonts.ready`（否则 canvas 量到的是回退字体的字宽）
2. 用**同字体**把标题画进离屏 canvas —— 逐字 `fillText` 并手动累加 `letter-spacing`
3. `getImageData` 采 `alpha > 110` 的点（按 dpr 换算步长），打散后取 260 个
4. 在每个真实字形位置放 4px 香槟金光点（`position: fixed`），GSAP 向外飞散 58–268px + 缩到 0.35 + 淡出
5. 结束后移除节点；标题置 `visibility: hidden` 且不再回来

### 泛涟漪光圈

- 一个 `<button>` + 三层 `.ring-wave`，状态只在「空 ↔ 非空」**布尔跳变**时切换，避免每次按键重启动画
- 空态用 `animation: none` 而不是 `animation-play-state: paused`：paused 会把动画值冻在当前帧，
  空态会残留一个半展开的静态圆环；`none` 才真正回落到 `opacity: 0`
- `.opening-ring.is-active .ring-wave` 里的 `animation` **简写会把 `animation-delay` 一起重置为 0**，
  所以有字状态必须再写一遍延迟，否则三层涟漪会同步扑出

## 开场交互与光球

### 开场阶段

| # | 阶段 | 说明 |
| --- | --- | --- |
| 1 | 初始 | 顶部光球 + 花体标题 `Tarot`；屏幕中央一张牌背（3D，高约占视口 42%）；下半屏留白 |
| 2 | 点牌背 | 透明 DOM 命中区（每帧对齐 3D 牌背投影）→ 9 张（窄屏 8 张）先叠回牌堆，再向扇形散开 |
| 3 | 炸标题 | 与扇面几乎同时触发，星光散进上方暗区后标题永久消失 |
| 4 | 问句 | `Whisper your question…`，Cormorant Garamond 斜体，淡入 |
| 5 | 输入框 | 无边框 / 无背景 / 无 placeholder / 居中 / 香槟金光标；桌面端自动聚焦，移动端不唤起键盘 |
| 6 | 传统提示 | 英文两行，衬线斜体，次要文字色，纯提示不做任何技术限制 |
| 7 | 光圈 | 香槟金圆形，有字后变亮并缓慢涟漪扩散；**本批次点击不触发抽牌**，只给一次脉冲反馈 |

### 光球数据接口

界面与数据解耦，后续批次接入真实记录时**只需替换 `readOrbRecords()`**：

```js
window.TarotOrbs = {
  max: 3,                       // 最多 3 个
  storageKey: 'tarot_orbs',     // 预留键名（当前不写入）
  read: readOrbRecords,         // 当前返回 [] → 不显示光球
  render: renderOrbs,           // renderOrbs(records) 渲染 0–3 个
};
```

记录结构约定（`renderOrbs` 只用到数组长度与先后顺序）：

```js
{ at: 1789000000000, question: '我该不该换一份工作？',
  cards: [{ id: 'major-00', reversed: false }, /* ... */] }
```

- 传入 0 个 → 整行隐藏；1 个 → 居中常亮；2/3 个 → 居中对称，最旧那颗加 `.is-aging` 呼吸
- 多于 3 个 → 只保留最近 3 个（最旧的被挤出）
- 本批次不做：光球点击回看（批次 3）、炸成星光（批次 2）、新光球挤入动画（批次 3）

## AI 解读

- 前端：问题输入框（≤200 字）+「AI 解读」按钮，**用户点击才发起请求**
- 加载状态：面板呼吸光晕（不使用转圈），返回后逐字打字机显示
- 接口：`POST /api/tarot`
  - 请求 `{ question, cards: [{ name, position, reversed, en?, meaning?, keywords? }] }`
  - 响应 `{ success, reading }` 或 `{ success, error }`；响应头 `X-Tarot-Model` 标明实际使用的模型
- 后端 `functions/api/tarot.js`：校验入参 → 组装系统提示词 → 调智谱 GLM → 返回

### 模型与容错

| 项 | 值 |
| --- | --- |
| 主模型 | `glm-4.7-flash` |
| 备用模型 | `glm-4.6`（主模型过载时自动降级） |
| 超时 | 总预算 28s（需求 30s，留 2s 给平台收尾） |
| thinking | **显式关闭** |

两个关键工程决策（均为实测得出）：

1. **关闭思考链**：`glm-4.7-flash` 是推理型模型，默认会先产出约 800–1000 个 reasoning token 才轮到正文，容易把 `max_tokens` 吃光导致正文为空（`finish_reason=length`）。加 `thinking: {type:'disabled'}` 后正文完整，耗时从 ~13s 降到 ~4.5s。
2. **自动降级**：实测 `glm-4.7-flash` 高峰期会出现整段时间不可用（连续 6 次全部返回 `429 / code 1305`），此时自动改用 `glm-4.6`。改 `GLM_FALLBACK_MODEL = null` 可退化为"只用主模型"。

## 环境变量

Pages 项目需要 `GLM_API_KEY`。已通过 API 配置好，手动配置方式：

**Cloudflare 后台**

1. 打开 <https://dash.cloudflare.com> → 选账号 → 左侧 **Workers & Pages**
2. 点进 **tarot-mucha** 项目 → **Settings** → **Environment variables**
3. 在 **Production** 与 **Preview** 两栏各加一条：
   - 变量名 `GLM_API_KEY`
   - 值填智谱开放平台的 API Key
   - 类型选 **Secret**（加密存储，之后不可回读）
4. **Save** 后必须**重新部署**一次才会生效（本仓库推送到 `main` 会自动重部署）

**命令行**

```bash
npx wrangler pages secret put GLM_API_KEY --project-name=tarot-mucha
```

> Key 只从 `env.GLM_API_KEY` 读取，不写入任何文件、不返回给前端、不打日志。

## 玩法与实现

| 项目 | 说明 |
| --- | --- |
| 洗牌 | Fisher-Yates 洗乱全部 78 张 |
| 抽牌 | 取前 3 张 → 过去 / 现在 / 未来，天然不重复 |
| 正逆位 | 每张独立 50% 概率，优先用 `crypto.getRandomValues`（拒绝采样避免偏差） |
| 逆位展示 | 3D 模式下牌体绕 Z 轴旋转 180°；降级模式下图 `rotate(180deg)` |
| 提问 | 在首屏输入，抽牌后带上问题；AI 面板回显将被使用的问题；可以为空 |
| 顶部光球 | 最多 3 个，居中对称，从左到右 = 最旧 → 最新；最旧那颗呼吸，其余常亮（只有 1 个时也常亮） |
| 数据存储 | 抽牌与提问**不落盘**。启动时清掉早期版本遗留的 `tarot_history` 键；`tarot_orbs` 为后续批次预留，当前只读不写 |

## 数据格式

`js/data.js`

```js
{ id: "major-00", file: "0愚人.jpg", name: "愚人", en: "The Fool",
  suit: "major", suitCn: "大阿卡纳", num: 0, arcana: "major" }
```

`data/meanings.js` — 键与 `id` 一一对应

```js
"major-00": {
  name: "愚人", en: "The Fool",
  upKeys: ["全新的开始", ...], up: "正位含义……",
  revKeys: ["鲁莽", ...],      rev: "逆位含义……"
}
```

两者均为**全局变量**（`TAROT_CARDS` / `TAROT_MEANINGS`），用普通 `<script>` 引入；`js/app.js` 与 `js/scene.js` 是 ES Module。

## 牌面资源

- 78 张牌 + 1 张牌背，命名规则：
  - 大阿卡纳：`{序号}{牌名}.jpg`，序号 0–21（RWS 编号：8 力量、11 正义）
  - 小阿卡纳：`{花色}{点数}.jpg` + `{花色}{宫廷}.jpg`
  - 花色：圣杯 / 宝剑 / 星币 / 权杖；宫廷：侍从 / 骑士 / 王后 / 国王
- 牌背 `cards/back.jpg` 由 `pictrues/牌背.png`（4.0MB）转 JPEG 压缩至 ~466KB
- 牌面统一 1080×1920（9:16）

## 部署

- 托管：Cloudflare Pages，项目名 `tarot-mucha`
- 仓库：<https://github.com/peidongl98/tarot-mucha>（`main`）

### 自动部署（已配置）

**推送到 `main` 即自动上线**。

- 工作流 `.github/workflows/deploy.yml`，用 `cloudflare/wrangler-action` 执行 `wrangler pages deploy`
- 运行记录：<https://github.com/peidongl98/tarot-mucha/actions>；也可在 Actions 页面 **Run workflow** 手动触发
- 凭证存仓库 Secret（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`），不落文件
- 部署根目录是仓库根，wrangler 会**自动编译 `functions/` 为 Pages Functions**
- `pictrues/` 已 gitignore，checkout 出来即发布内容，无需构建步骤

> 本账号未安装 Cloudflare Pages 的 GitHub App，因此用 **GitHub Actions + Direct Upload**，效果等同于 CF 原生 Git 集成（推送即部署），区别只是部署由 GitHub 侧发起、日志在 Actions 里看。

### 手动部署（备用）

```bash
mkdir -p ../dist && git archive --format=tar HEAD | tar -x -C ../dist
npx wrangler pages deploy ../dist --project-name=tarot-mucha --branch=main
```

### 想改用 CF 原生 Git 集成

需要先在 Cloudflare 后台安装一次 GitHub App：**Workers & Pages → Create → Pages → Connect to Git → 授权 GitHub → Only select repositories → 勾选 `tarot-mucha`**。
注意：**现有 Direct Upload 项目无法转为 Git 集成**，必须删掉 `tarot-mucha` 重建（或换项目名），改完可删掉 `deploy.yml`。

## 版权与声明

牌义采用公版 Rider-Waite-Smith 体系的中文表述；AI 解读由大模型生成。仅供娱乐参考，不构成任何专业建议。

## 路线图

- **批次 A（已完成）**：抽牌 + 牌义 + 历史 + 部署
- **批次 B（已完成）**：3D 沉浸式视觉（粒子星云 / 仪式舞台 / 3D 卡牌）+ AI 解读
- **批次 C（已完成）**：提问前移、输入框粒子雾、花体英文标题、去掉说明性文字、移除 localStorage 历史
- **批次 D（已完成）**：开场交互重做（牌背 → 扇形，圆心移到页面顶部、向下辐射）、英文传统提示两行、顶部光球静态展示
- 后续批次：光球点击回看 / 炸成星光 / 新光球挤入、抽牌与上滑解读接回开场、音效、牌阵扩展、PR 预览部署
