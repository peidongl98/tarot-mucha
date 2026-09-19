# 穆夏塔罗 · Mucha Tarot

在线塔罗抽牌站：**过去 / 现在 / 未来** 三张牌，内置 78 张公版牌义，无需登录。

- 纯静态：HTML / CSS / JS，**零构建、零框架、零 CDN**
- 全部资源本地打包（图片、数据都在仓库里）
- 抽牌记录存在浏览器 `localStorage`，不上传任何数据
- 纯娱乐用途

## 目录结构

```
MuchaTarot/
├── index.html          入口页
├── css/
│   └── style.css       全部样式（含移动端适配）
├── js/
│   ├── data.js         78 张牌面映射（id / 文件名 / 牌名 / 花色）
│   └── app.js          抽牌逻辑、渲染、localStorage 历史
├── data/
│   └── meanings.js     78 张牌义（正位 / 逆位 / 关键词）
├── cards/              78 张牌面 JPG + back.jpg（牌背）+ favicon.png
├── pictrues/           原始素材（未压缩的牌背 PNG，保留备份）
└── README.md
```

## 本地运行

无需构建。任选一种：

```bash
# Python
python -m http.server 8080

# Node
npx serve .
```

然后打开 <http://localhost:8080>。

> 直接双击 `index.html`（file:// 协议）也能抽牌，但部分浏览器在 file:// 下会禁用 localStorage，历史记录可能无法保存。建议用本地 HTTP 服务。

## 玩法与实现

| 项目 | 说明 |
| --- | --- |
| 洗牌 | Fisher-Yates 洗乱全部 78 张 |
| 抽牌 | 取前 3 张 → 过去 / 现在 / 未来，天然不重复 |
| 正逆位 | 每张独立 50% 概率，优先用 `crypto.getRandomValues`（拒绝采样避免偏差），不可用时退回 `Math.random` |
| 逆位展示 | 牌面图 CSS `rotate(180deg)` |
| 历史 | `localStorage` 键名 `tarot_history`，最多保留 30 条，存时间戳 + 三张牌的 id 与正逆位 |

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

两者均为**全局变量**（`TAROT_CARDS` / `TAROT_MEANINGS`），不使用 ES Module，以便在 `file://` 下直接打开也能运行。

## 牌面资源

- 78 张牌 + 1 张牌背，命名规则：
  - 大阿卡纳：`{序号}{牌名}.jpg`，如 `0愚人.jpg`、`21世界.jpg`（序号 0–21，采用 RWS 编号：8 力量、11 正义）
  - 小阿卡纳：`{花色}{点数}.jpg` + `{花色}{宫廷}.jpg`，如 `圣杯1.jpg`、`权杖国王.jpg`
  - 花色：圣杯 / 宝剑 / 星币 / 权杖；宫廷：侍从 / 骑士 / 王后 / 国王
- 牌背 `cards/back.jpg` 由原 `pictrues/牌背.png`（4.0MB）转换为 JPEG 并压缩至 ~466KB
- 所有牌面尺寸统一 1080×1920（9:16）

## 部署

线上地址：<https://tarot-mucha.pages.dev>

- 托管：Cloudflare Pages，项目名 `tarot-mucha`
- 代码仓库：<https://github.com/peidongl98/tarot-mucha>（`main` 分支）

### 自动部署（已配置）

**推送到 `main` 分支即自动上线**，无需手动操作。

- 工作流：`.github/workflows/deploy.yml`，由 GitHub Actions 调用 `cloudflare/wrangler-action` 执行 `wrangler pages deploy`
- 运行记录：<https://github.com/peidongl98/tarot-mucha/actions>
- 也可在 Actions 页面点 **Run workflow** 手动触发
- 凭证以仓库 Secret 形式保存（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`），**不落任何文件**
- `pictrues/` 已被 `.gitignore` 排除，Actions 里 checkout 出来就是待发布内容，因此不需要构建步骤，也不需要额外过滤

> 说明：本账号未安装 Cloudflare Pages 的 GitHub App，所以用的是 **GitHub Actions + Direct Upload** 组合，效果等同于 CF 原生 Git 集成（推送即部署）。区别只在于部署由 GitHub 侧发起、构建日志在 GitHub Actions 里看。

### 手动部署（备用）

```bash
# 导出已跟踪文件到临时目录（自动排除 pictrues/）
mkdir -p ../dist && git archive --format=tar HEAD | tar -x -C ../dist

# 上传（需要 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID 环境变量）
npx wrangler pages deploy ../dist --project-name=tarot-mucha --branch=main
```

### 若想改用 Cloudflare 原生 Git 集成

需要先在 Cloudflare 后台安装一次 GitHub App：**Workers & Pages → Create → Pages → Connect to Git → 授权 GitHub → 选择 Only select repositories → 勾选 `tarot-mucha`**。
注意：**现有的 Direct Upload 项目无法直接转为 Git 集成**，必须删掉 `tarot-mucha` 项目后重建（或换一个新项目名），改完后可删掉本仓库的 `deploy.yml`。

## 版权与声明

牌义采用公版 Rider-Waite-Smith 体系的中文表述，仅供娱乐与自我反思，不构成任何专业建议。

## 路线图

- **批次 A（已完成）**：抽牌 + 牌义 + 历史 + 部署
- 批次 B（未做）：发牌 / 翻牌动效、音效、牌阵扩展
