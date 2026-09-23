/* functions/api/whispers.js — Cloudflare Pages Function
 * 路由：/api/whispers
 *   GET ?n=12   → 从整张 orbs 表随机抽取 n 条「提问」文本（跨设备、匿名、仅 question 字段）
 *
 * 用途：独立的「低语墙」查看页（whispers.html）。只回传 question，不回传 cards/reading，
 *       不泄露设备身份，因此可公开浏览。排除 hidden=1 的记录（被本地删除的不在这里出现）。
 *
 * 未配置 D1 绑定时（env.DB 为空）优雅降级：返回 backend:false，前端提示「暂无低语」。
 *
 * ⚠️ 占位符过滤（MIN_Q_LEN）：只回传裁剪后长度 >= 3 的提问。
 *   背景 —— 验证脚本曾用 page.addInitScript 注入假历史（question = 'q1'/'q2'/'q3'），
 *   而页面启动时会把「仅本地有的记录」补推上云，导致占位符被写进生产库并出现在低语墙上。
 *   源头已加防护（脚本侧拦截 POST /api/orbs），这里再加一道展示门槛兜底。
 */

const DEFAULT_N = 12;
const MAX_N = 30;
/* 短于该长度的提问不展示（挡住 q1/q2/q3 这类测试占位符；真实提问不会只有 1–2 字） */
const MIN_Q_LEN = 3;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const db = env.DB;
  if (!db) return json({ success: true, questions: [], backend: false });

  let n = parseInt(new URL(request.url).searchParams.get('n') || '', 10);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_N;
  n = Math.min(n, MAX_N);

  try {
    const { results } = await db
      .prepare(
        "SELECT question FROM orbs WHERE hidden=0 AND length(trim(coalesce(question,'')))>=? ORDER BY random() LIMIT ?"
      )
      .bind(MIN_Q_LEN, n)
      .all();
    const questions = (results || [])
      .map((r) => (r.question || '').trim())
      .filter((q) => q.length >= MIN_Q_LEN);
    return json({ success: true, questions, backend: true });
  } catch (e) {
    return json({ success: false, questions: [], error: 'db-error' }, 500);
  }
}
