/* functions/api/orbs.js — Cloudflare Pages Function
 * 路由：/api/orbs
 *   GET  ?device_id=...            → 最近 N 条记录（匿名设备级）
 *   POST { device_id, at, question, cards, reading } → 插入一条
 *   DELETE ?device_id=...&at=...   → 按设备+时间戳删除一条
 *
 * 存储：Cloudflare D1，绑定名 DB（在 Pages 后台 Functions → D1 bindings 添加）。
 * 未配置绑定时（env.DB 为空）优雅降级：GET 返回 backend:false，前端回退 localStorage。
 *
 * 身份：匿名 device_id（前端 crypto.randomUUID 生成，存 localStorage），无需登录。
 */

const CAP = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const db = env.DB;
  if (!db) return json({ success: true, orbs: [], backend: false });
  const deviceId = new URL(request.url).searchParams.get('device_id') || '';
  if (!deviceId) return json({ success: false, error: 'missing device_id' }, 400);
  const { results } = await db
    .prepare('SELECT at, question, cards, reading FROM orbs WHERE device_id=? ORDER BY at DESC LIMIT ?')
    .bind(deviceId, CAP)
    .all();
  const orbs = (results || []).map((r) => ({
    at: r.at,
    question: r.question || '',
    cards: safeParse(r.cards, []),
    reading: r.reading || '',
  }));
  return json({ success: true, orbs, backend: true });
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  const db = env.DB;
  if (!db) return json({ success: false, error: 'no-db' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'bad-json' }, 400); }
  const { device_id, at, question, cards, reading } = body || {};
  if (!device_id || !at || !Array.isArray(cards) || cards.length !== 3) {
    return json({ success: false, error: 'invalid' }, 400);
  }
  await db
    .prepare('INSERT OR REPLACE INTO orbs (device_id, at, question, cards, reading) VALUES (?,?,?,?,?)')
    .bind(device_id, at, String(question || ''), JSON.stringify(cards), String(reading || ''))
    .run();
  return json({ success: true });
}

export async function onRequestDelete(ctx) {
  /* 云端记录刻意不可删：删除只发生在本地（前端把 at 记入隐藏集，云端原样保留）。
   * 这里直接拒绝，确保任何路径都无法移除线上记录（"线上记录一直在"）。 */
  return json({ success: false, error: 'delete-disabled' }, 403);
}

function safeParse(s, fallback) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch (e) { return fallback; }
}
