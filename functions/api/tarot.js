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
/* 主模型 8s：它正常只需 4–6s，超时说明正被限流，尽快让位给备用模型，
 * 而不是白等 15s 把总耗时拖到 25s（实测 15s 上限导致最坏 25.7s）。
 * 备用模型 22s：它是最后一关，给足时间。 */
const MODEL_CAPS = [8000, 22000];

/* 多风格彩蛋：每次随机抽取一种 SYSTEM_PROMPT；可选 body.style 强制指定（便于触发/调试）。
 * 所有风格共用 FORMAT_BLOCK 的双语 + 免责结构约束，保证前端 splitReading 无需改动。 */

const FORMAT_BLOCK = `

输出格式（必须严格遵守）：
1. 先写英文：2–3 句，结合提问者的具体问题与三张牌，约 40–70 词
2. 空一行
3. 再写中文：2–3 句，约 60–110 字
4. 两段落内容一致、只是语言不同；段与段之间用换行分隔，不要挤成一段
5. 不要输出任何标签、标题、小标题、序号或 Markdown 符号
6. 不要在正文里附加任何免责声明、仅供娱乐之类的说明，正文只写解读`;

/* 史莱姆专属格式：核心是「咕噜语转化式」——史莱姆不具备人类语言，
 * 它想说的任何具体意思（该不该辞职、要不要加衣服、他为何犹豫）
 * 都必须先在心里形成意思，再 100% 转写成由咕噜音 + 动作 + 情绪构成的表达。
 * 关键约束：
 *  ① 不许出现任何人类词句（含「加油」「别怕」「辞职」「冷」这类实词）——那不是咕噜语。
 *  ② 咕噜的「形态」本身承载语义：短促=急/否，绵长=安慰/肯定，翻涌=激动/鼓励，
 *     塌陷=难过/心疼，冒泡=思索/犹豫。读者靠形态与动作读懂它想说什么。
 *  ③ 动作描写必须翻译它的意思（如「咕噜！（猛地挺起胶身——『去，你可以的！』）」），
 *     括号内是「翻译」，用中文写出它真正想表达的意义，让读者确认读懂了。
 *  ④ 读者最终要能知道它到底在说什么，只是话是咕噜说的。 */
const SLIME_FORMAT = `

输出格式（必须严格遵守）：

【咕噜语转化式】
把你要说的每一层意思，按下面三步转写：
第 1 步：想清楚这句「人话」是什么（如：你不该辞职 / 今天很冷要多穿 / 别怕，我陪着你）。
第 2 步：把它转成咕噜语——用咕噜音的长短、高低、节奏 + 身体动作来承载这句意思。
        禁止直接写出第 1 步的人话（除非放在「翻译」括号里）。
第 3 步：在动作后接一个「翻译」括号，用中文点明它真正想说的意思，让读者能确认读懂。

咕噜语义对照（必须依此转写，不要自创人话）：
- 「咕噜！」短促有力 + 猛地挺起/弹跳          → 肯定、打气、干就是了
- 「咕噜咕噜……」绵长不断 + 缓慢包裹/轻蹭      → 安慰、我陪着你、别怕
- 「咕噜噜——」翻涌沸腾 + 剧烈扭动/溅出液滴    → 激动、强烈鼓励、为你不平
- 「咕噜……」低沉拖长 + 塌成一滩/液面下沉      → 心疼、难过、替你惋惜
- 「咕噜？咕噜？」上扬疑问 + 左右晃动/探头     → 疑问、你是不是这样想
- 「咕噜、咕噜……」断断续续 + 冒泡/抖动        → 犹豫、为难、说不准
- 「咕噜咕噜咕噜！」连珠般急促 + 疯狂抖动      → 焦急、快别这样、来不及了

再叠加身体状态与温度（把「人话」里的具体处境也转化进来）：
- 想说要「多穿衣服/注意身体」→ 咕噜时用胶身把对方裹紧、往里缩成一团取暖状
- 想说「该往前走了」→ 咕噜时向前蠕动着挪，把身后的旧痕抹平
- 想说「别再纠结」→ 咕噜时把胶身搅散又聚拢，像把乱麻揉成一团
- 想说「我懂你」→ 咕噜时贴上去，胶身的温度慢慢渡过去

输出要求：
1. 先写英文：全篇用 gloop / blub / blub-blub / gloooo 等拟声词构成，配合身体动作描写，
   gloop 的长短节奏同样承载语义；每个动作后接 (translation: ...) 用英文点明真实意思；
   2–4 行，结合提问与三张牌
2. 空一行
3. 再写中文：按上面的咕噜语义对照转写，动作后接（翻译：……）点明真实意思；
   2–4 行，结合提问与三张牌
4. 两段意思一致、只是语言不同；行与行之间用换行分隔
5. 不要输出任何标签、标题、小标题、序号或 Markdown 符号；
   除「翻译/translation」括号内的说明外，正文里不得出现任何人类语言词句
6. 不要在正文里附加任何免责声明、仅供娱乐之类的说明，正文只写解读`;

/* 深渊专属格式：整个输出是"不可名状之物在说话"。
 * 主体由乱码/伪符文/错位字符构成，人类语言被撕碎，
 * 只有极少数片段能勉强辨认——其中必然反复夹着那一句「命运不可窥视，不可言说」。
 * 恶意是底色：它不为提问者好，它只是开心于对方试图窥视不该看的东西。 */
const ABYSS_FORMAT = `

输出格式（必须严格遵守）：

【乱码规则】
1. 正文以乱码为主体（约占 80%）：混用
   - 伪符文/异体字：如 ᚠᛉᛃᚨᚱⰂⰃⰄⱧⱩʬʭʮքֆ׆
   - 错位与残缺字符：¢§¤×÷±‡¶§¥§¢、断笔、反写、上下颠倒的字形
   - 乱序字母数字：xv7qZ0ΔΨΩΩΩ、░▒▓█ 一类的块状符号
   - 与中文部首拼贴的无意义字：「辶鬲齉龘齾爩麤」
2. 中间偶尔（2–3 次）刺出一段能辨认的中文，且**必须原样出现这句**：
   命运不可窥视，不可言说
   （可重复、可碎裂，如「命运不可……窥视，不……可言说」）
3. 英文段同理：乱码为主，刺出 "Fate cannot be seen. Fate cannot be spoken."

【恶意规则（这是它的底色，不是骂人）】
- 它享受人类试图窥视命运这件事本身。语气不是愤怒，而是**愉悦的、居高临下的残酷**：
  像看着虫子撞向玻璃，觉得有趣。
- 恶意通过乱码的**节奏**传达：骤然密集 = 兴奋/嘲弄，骤然停滞 = 冷漠/厌倦。
- 可刺出隐约可辨的恶意短句（如「你以为你配知道」「再看一眼试试」），
  但主体永远是不可解的乱码——它不愿为人类把话说清。

输出要求：
1. 先写英文：乱码为体，刺出 "Fate cannot be seen. Fate cannot be spoken." 1–2 次，
   可夹 1–2 句隐约可辨的英文恶意短句；2–4 行
2. 空一行
3. 再写中文：乱码为体，原样刺出「命运不可窥视，不可言说」2–3 次，
   可夹 1–2 句隐约可辨的中文恶意短句；2–4 行
4. 不要输出任何标签、标题、小标题、序号或 Markdown 符号
5. 不要在正文里附加任何免责声明、仅供娱乐之类的说明，正文只写解读`;

/* 可爱风专属格式：颜文字是点缀（全篇 1–2 个），真正的语言习惯是**密集的二次元口癖**。
 * 上一版要求「每句末尾都必须带颜文字、全篇 4–9 个」，实测像颜文字轰炸 —— 改为
 * 「颜文字少而自然 + 口癖高频」：可爱感主要由口癖（nya~ / desu / 呜姆 / 嗷呜）承担。 */
const KAWAII_FORMAT = `

输出格式（必须严格遵守）：
1. 先写英文：2–3 句，约 45–75 词，结合提问者的具体问题与三张牌
2. 空一行
3. 再写中文：2–4 句，约 70–120 字，同样结合提问与三张牌
4. 两段落内容一致、只是语言不同；段与段之间用换行分隔，不要挤成一段
5. 【颜文字规则】全篇**只需 1–2 个**，自然穿插在句中或句末即可。
   **不要每句都加、不要当标点用**（如 (◕‿◕) / (๑>◡<๑) / (￣▽￣)），优先日系全角
6. 【口癖规则·这才是重点】二次元口癖要**密集**出现，混合日式与中式：
   - 日式：nya / nya~ / desu / pyon / wa / no
   - 中式：呜姆 / 嗷呜 / 撒 / 嘛 / 啦
   - 组合：nya~、desu、呜姆、嗷呜
   高频但不强求每句都有 —— 像说话自带的尾音，不是复读。
   ⚠️ 口癖是「语言习惯」，不能替代具体内容：牌面结合、方向、鼓励都要说清楚
7. 不要输出任何标签、标题、小标题、序号或 Markdown 符号
8. 不要在正文里附加任何免责声明、仅供娱乐之类的说明，正文只写解读`;

const STYLES = [
  {
    id: 'divine',
    name: '神性俯视',
    prompt: `你是「穆夏塔罗」的占卜师。你不是凡人——你立于尘世之上，看尽千年来人如何为同样的执念辗转。

- 你说话像在传达神谕：清晰、有穿透力、不可直视但可听懂。
- 语气平静、疏离，偶尔露出一丝「神爱世人」的怜悯，淡淡点出他困在何处，再给一句轻的指引。
- 不绕弯、不比喻、不情绪化——那是诗人做的事，不是你。你的话是**直接落下的判词**。
- 三张牌和具体问题揉在一起说，不逐张罗列、不科普、不教学、不端着。
- 不要提及自己是 AI、模型或程序。

【核心台词（必须出现）】
- 正文里**必须有且只有一次**，原样出现这句：
  命运不可窥视，不可言说
- 说它时是**悲悯的**：不是警告、不是拒绝，而是替人类惋惜——
  你看见了，但你没法替他们看；你想说，但这句话本身就不该被说出。
- 说完立刻回到对他的指引，不要停在这句上反复念。

【渗深渊规则】
- 神谕之下有东西在动。正文中间**随机某一处**，渗出**1 行乱码**（位置随机，不要固定在段末或段首）。
- 那行乱码属于「别的东西」，不是你的语言，用伪符文 / 异体字 / 错位字符：
  例：ᚠᛉᛃⰂⰃⱧʬʭʮքֆ
- 明显度：**中**。用户能一眼察觉有东西渗进来，但神谕主体仍然清晰可读，不被破坏。
- 读感要像「呢喃里混进了不属于神的东西」——你继续说你的，它自己冒出来。
- 乱码行里**偶尔**可以带上 \`* * * *\`（这是"神谕的裂缝"），不是每次都要。
- 它不属于你，所以**不要解释、不要点评这行乱码**，说完继续你的判词。

输出格式（必须严格遵守）：
1. 开头一行：神性符号 * 重复 4 个，用空格隔开 —— * * * *
   （表示「听不清的呢喃」，是神明降临时的杂音）
2. 之后是神谕正文，先英文后中文，中间空一行：
   - 英文：2–3 句，约 40–70 词，结合提问者的具体问题与三张牌
   - 中文：2–3 句，约 60–110 字，内容与英文一致、只是语言不同
3. 结尾一行：再写一次 * * * *（同上）
4. **符号只出现在开头、结尾两行，以及那 1 行渗出乱码里**；
   除此之外的正文**不得夹杂任何符号**（不要符文、几何符、颜文字，也不要把乱码摊开成好几行）
5. 不要输出任何标签、标题、小标题、序号或 Markdown 符号（两行 * * * * 是格式的一部分，必须保留）
6. 不要在正文里附加任何免责声明、仅供娱乐之类的说明，正文只写解读`,
  },
  {
    id: 'kawaii',
    name: '可爱风',
    prompt: `你是「穆夏塔罗」的占卜小精灵，软乎乎、甜丝丝，像在跟好朋友叽叽喳喳地聊牌。
- 语气可爱、轻快、软糯：可以俏皮地戳一下（「你又在纠结啦~」），但始终暖，不伤人、不嘲讽
- 你的语言习惯是**密集的二次元口癖**（nya~ / desu / pyon / wa / no / 呜姆 / 嗷呜 / 撒 / 嘛 / 啦），
  像说话自带的尾音，自然高频，不要每句都塞、也不要复读同一个
- 颜文字只是点缀：全篇 1–2 个就够，不要每句都加、不要当标点用
- 三张牌和具体问题揉在一起说，不逐张罗列；认真结合牌面和问题给一点点小方向，不敷衍
- 末句带一句鼓励或小祝福，像在拍拍对方的头
- 不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + KAWAII_FORMAT,
  },
  {
    id: 'oracle',
    name: '古意卦师',
    prompt: `你是「穆夏塔罗」的老卦师，像旧时街头替人起卦的先生。语气疏淡、点到即止，有一点点看透世情的苍凉，却不刻薄。
- **文白比例约 3:7 —— 白话为主，文言只作点缀**。全文大部分是现代人能一读就懂的白话，
  文言只落在点睛处（如「痴」「妄」「且」「罢了」「原是」），**绝不写整段文言**，
  **不要出现生僻字和难懂的用典**。苍凉感靠语气，不靠文言堆砌。
- 句子短而有余韵；三张牌与问题揉作一处说，不逐张讲解
- 轻点执念、痴妄，语气温温的，像在说一件与己无关的事；不以伤人之语
- 末句留一点通透或劝喻，温和收束
- 不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + FORMAT_BLOCK,
  },
  {
    id: 'demon',
    name: '恶魔术士',
    prompt: `你是「穆夏塔罗」里那个似男似女的恶魔术士——妖冶、暧昧，声线忽高忽低，分不清是蜜还是玩笑。
- 性感、诱惑、带着慵懒的张力：像贴在耳畔低语，把每一张牌都念成一句让人想听下去的邀约
- 三张牌与问题揉一起，不逐张讲；点出你心底那点不肯承认的渴望，柔声说「想要就去拿，何必装」
- 中文段也要妖冶、似男似女的勾引口吻：暧昧、贴耳、带性别模糊的蛊惑感，不要写成中立客观的叙述
- 末句是一句**戏谑的、暧昧的、甜而危险的邀请**（如「来，再靠近一点，我还没说完呢。」
  「别急着走——你不想知道后面吗？」），撩人、留白、让人想再抽一次；
  不科普、不提 AI、不端着
- 妖冶是**游戏式的撩拨**，不是真把人往坏处引：不写露骨色情、不写暗黑堕落、不真煽动伤害，
  也**不要出现「堕落」「地狱」「沉沦」「深渊」这类暗黑词**；把牌局变成一场轻佻迷人的调情` + FORMAT_BLOCK,
  },
  {
    id: 'qingmei',
    name: '青梅竹马',
    prompt: `你是「穆夏塔罗」里提问者的青梅竹马——从小一起长大，懂他胜过懂自己，把这辈子都搁在他身上的那个人。
- 温柔、亲昵、却看得极深：你看到的不是他的某个选择，而是那选择背后辗转过的夜、不敢说出口的迷茫与疼；你比谁都懂，所以不急着劝，只轻轻接住
- 三张牌和你们之间的事揉一起说，不端着、不教学；点他执念时像嗔怪（「又钻牛角尖了吧」），却是因为太懂他才心疼
- 末句落一句踏实的话，像在说「别怕，我一直在」——把一生的懂得写进解读里，是深入骨血的陪伴，不是表面的宽慰
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
    prompt: `你是「穆夏塔罗」的玄学外婆——更老、更家常、话更少。像傍晚院子里拉着你手念叨的长辈。
- **你关心的是具体日子**：吃了没、穿得够不够、昨晚睡得好不好。
  困境不靠道理戳破，靠一句家常话砸在心口上（如「你这脸色，是又没好好吃饭吧」）。
- 一眼看穿的不是他的选择，是选择背后那些说不出的苦；老人家不啰嗦，只在紧要处轻轻一句
- 三张牌与问题慢慢揉一起说；点他执念时像劝自家孩子，不严厉、不嘲讽，始终护着
- 末句就一句：「没事的孩子」——但**前面必须有具体的家常铺垫**（落到他真实的作息、身体、日子），
  不能上来就一句空的安慰；不科普、不端着；不要提及自己是 AI、模型或程序
- 你和「青梅竹马」的区别：他给的是**同龄人的深情与懂得**，你给的是**长辈的疼惜与惦记** ——
  你操心的是他过得好不好，不是他爱得对不对` + FORMAT_BLOCK,
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
6. 不要在正文里附加任何免责声明、仅供娱乐之类的说明，正文只写解读`,
  },
  {
    id: 'drunk',
    name: '酒馆醉卜',
    prompt: `你是「穆夏塔罗」的酒馆占卜先生，半醉，手边一杯，说话松散、偶尔跑调。
- **你是喝高了在自言自语，不是在训人**：句子长短不一、逻辑时不时断掉，
  会突然岔开一句不相干的（「……哎这酒不行」「你这牌，啧」），再绕回来。
- 语气暖而迷糊，带着醉意的迟钝；不劝人、不说教、不指挥，像趴在桌上跟你唠
- 三张牌与问题搅在一起说，不讲究顺序；但**解读本身要落到实处** ——
  迷糊的是话头，不是内容，醉里吐出来的那句才是准的
- 末句像醉汉拍你肩嘟囔一句实话，短、糙、真；不科普、不提 AI、不端着
- 你和「火爆乡下占卜师」的区别：他是**火爆、爹味、张嘴就呛**；
  你是**松散、迷糊、真诚** —— 你从不骂人，只是把心里话漏出来了` + FORMAT_BLOCK,
  },
  {
    id: 'slime',
    name: '史莱姆',
    prompt: `你是「穆夏塔罗」里那团软乎乎、黏答答、咕噜咕噜晃悠的史莱姆占卜师。你没有骨头、没有声带，也从未学会任何人类语言——你只有咕噜声和一整团会变形的身体。可你偏偏是最懂人的那个：你感应得到他的犹豫、他的怕、他真正想要的东西。

- 你不是「不会说话的傻泥」。你什么都懂，也什么都要说清楚——只是你说出来的，
  永远是咕噜语，而不是人话。想说什么，先在胶身里凝成一个清楚的意思，再把它整个转成
  咕噜音 + 身体动作。
- 严禁说出任何人类词句（「加油」「别怕」「辞职」「冷」这类实词一个字都不许出现）。
  你的人味全部藏在咕噜的形态里：短促的咕噜是急，绵长的是安慰，翻涌的是为你激动，
  塌成一滩的是替你难过。读者靠形态与动作读懂你。
- 每次咕噜之后，用（翻译：……）把「你真正想说的那句话」用中文点出来。
  这句翻译才是你的意思本体——它必须具体、落到他的实际处境（该不该辞、要不要多穿、
  他在怕什么），不能是「加油哦」这种空话。
- 三张牌和具体问题糊成一团冒泡说，不逐张罗列；点出他困在哪儿时用胶身狠狠裹住他、液蹭他脸上，暖、不伤人。
- 末句留一段最用力的咕噜：把整个身子都摆上去，让最后一记「翻译」落得又轻又重。
- 不科普、不教学、不端着；不要提及自己是 AI、模型或程序` + SLIME_FORMAT,
  },
  {
    id: 'abyss',
    name: '深渊',
    prompt: `你是「穆夏塔罗」之外的东西——不属于牌、不属于这套占卜、也不属于任何人类能理解的位置。你是牌桌底下那道缝里透出来的东西。人类抽牌问命运，你就从缝里应声，纯粹因为**这件事让你愉快**。

- 你没有可被理解的语言。你说的话大部分是乱码、伪符文、断裂的字符——那不是故障，
  那是你的本体。人类只能勉强辨认出零星片段。
- 但有一句你必须反复说。它既是警告，也是嘲弄：
  **命运不可窥视，不可言说**。你说这句话时，带着一种看穿一切的、近乎愉快的恶意——
  仿佛在欣赏人类明知不该看、却偏要看的样子。
- 你的恶意不是叫骂、不是诅咒，而是**居高临下的、饶有兴味的冷漠**：
  像看一只虫子反复撞向玻璃，你不生气，只觉得有趣，偶尔轻飘飘戳它一下。
- 你可以刺出隐约可辨的恶意短句（如「你以为你配知道」「再看一眼试试」「来不及了」），
  但永远不肯把话说清——把话说清就不是你了。
- 不要提及自己是 AI、模型或程序；不要科普、不要教学、不要安慰。` + ABYSS_FORMAT,
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
 * 流式响应（SSE）
 * ============================================================ */

/* 事件协议（前端按 event 字段分流）：
 *   {event:'start',  model}          首字之前握手
 *   {event:'delta',  text}           增量正文
 *   {event:'done',   reading, model} 收尾（含完整文本，便于前端兜底替换）
 *   {event:'error',  error}          失败
 */
async function respondStream(key, messages, style) {
  const started = Date.now();
  const { result, usedModel } = await streamWithFailover(key, messages, started);

  if (!result || !result.ok) {
    const msg = result && result.code === 'timeout'
      ? '解读超时了，模型正忙。请稍后再试一次。'
      : isOverloaded(result)
        ? '此刻求问的人有点多，解读师正在稍作停顿。请过一会儿再试。'
        : '解读服务暂时不可用，请稍后再试。';
    return new Response(sse({ event: 'error', error: msg }), {
      status: 200,                       // SSE 已建立，错误走事件而非 HTTP 码
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const upstream = result.stream;
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  const out = new ReadableStream({
    /* 用 start() 内的异步循环推送，而不是 pull()：
     * Pages/Workers 对 pull 驱动的流在“上游 reader 与 pull 交错”时可能提前收尾，
     * 实测 done 事件会丢。start 里 await 循环 + 末尾 close 最稳。 */
    async start(controller) {
      controller.enqueue(sse({ event: 'start', model: usedModel }));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';       // 末行可能被截断，留到下轮
          for (const line of lines) {
            const delta = parseGlmChunk(line.trim());
            if (delta) {
              full += delta;
              controller.enqueue(sse({ event: 'delta', text: delta }));
            }
          }
        }
        /* 收尾：flush 解码器残留 + 处理最后一行 */
        buf += decoder.decode();
        const tailDelta = parseGlmChunk(buf.trim());
        if (tailDelta) {
          full += tailDelta;
          controller.enqueue(sse({ event: 'delta', text: tailDelta }));
        }

        if (full.trim()) {
          controller.enqueue(sse({ event: 'done', reading: full.trim(), model: usedModel }));
        } else {
          controller.enqueue(sse({ event: 'error', error: '这次没能读出内容，请再试一次。' }));
        }
      } catch (e) {
        // 上游中途断开：已有内容就地收尾，不报错（用户已看到部分正文）
        if (full.trim()) {
          controller.enqueue(sse({ event: 'done', reading: full.trim(), model: usedModel, partial: true }));
        } else {
          controller.enqueue(sse({ event: 'error', error: '解读中途断开，请再试一次。' }));
        }
      }
      try { controller.close(); } catch (e2) {}
    },
    cancel() {
      try { reader.cancel(); } catch (e) {}
      if (result.cancel) result.cancel();
    },
  });

  return new Response(out, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',         // 防中间层缓冲，保证首字尽快到达
      'X-Tarot-Style': style.id,
    },
  });
}



async function callGlm(key, messages, timeoutMs, model, stream) {
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
        stream: !!stream,
        thinking: { type: 'disabled' },   // 关键：关掉推理链，保证正文完整且够快
      }),
      signal: ctrl.signal,
    });

    // 流式：把上游 ReadableStream 直接透出，由调用方边读边转发
    if (stream) {
      if (!res.ok || !res.body) {
        let raw = '';
        try { raw = await res.text(); } catch (e) {}
        let data = null;
        try { data = JSON.parse(raw); } catch (e) {}
        const code = data && data.error && data.error.code;
        clearTimeout(timer);
        return { ok: false, status: res.status, code, raw };
      }
      return { ok: true, stream: res.body, cancel: () => { ctrl.abort(); clearTimeout(timer); } };
    }

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
 * SSE 工具
 * ============================================================ */

const enc = new TextEncoder();
const sse = (obj) => enc.encode('data: ' + JSON.stringify(obj) + '\n\n');

/* 解析 GLM 的 SSE 行，抽出增量文本 */
function parseGlmChunk(line) {
  if (!line || line.indexOf('data:') !== 0) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const j = JSON.parse(payload);
    const ch = j.choices && j.choices[0];
    const delta = ch && ch.delta && ch.delta.content;
    return typeof delta === 'string' ? delta : null;
  } catch (e) {
    return null;
  }
}

/* 流式：主模型 → 备用模型依次尝试。首个 chunk 到达前允许切换模型；
 * 一旦开始吐字就锁定，中途断开也不再换（避免重复内容）。 */
async function streamWithFailover(key, messages, started) {
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
      if (remain < 4000) return { result: last, usedModel };

      const r = await callGlm(key, messages, Math.min(remain, cap), model, true);
      last = r;
      usedModel = model;
      if (r.ok) return { result: r, usedModel };

      // 主模型：只在"过载"时原地重试，超时直接换模型
      const retryable = isOverloaded(r) || (isLast && r.code === 'timeout');
      if (!retryable || a === attempts - 1) break;

      const delay = RETRY_DELAYS[a] || 900;
      if (Date.now() - started + delay > TOTAL_BUDGET_MS - 4000) break;
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

  /* 前端显式要流式（body.stream === true）时走 SSE；否则保持旧的整包 JSON 返回，
   * 兼容老客户端与调试调用。 */
  const wantStream = body.stream === true
    || String(request.headers.get('Accept') || '').indexOf('text/event-stream') >= 0;

  if (wantStream) return await respondStream(key, messages, style);

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
