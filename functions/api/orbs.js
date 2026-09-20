/* functions/api/orbs.js — Cloudflare Pages Function
 * 路由：/api/orbs
 *   GET  ?device_id=...            → 最近 N 条记录（含 hidden 标记，匿名设备级）
 *   POST { device_id, at, question, cards, reading } → upsert 一条（不重置 hidden）
 *   PATCH ?device_id=...&at=...    → 标记 hidden=1（「本地删除」的云端落点；记录不删）
 *   DELETE                         → 刻意禁用（403），线上记录永不移除
 *
 * 存储：Cloudflare D1，绑定名 DB。未配置时 GET 返回 backend:false，前端回退 localStorage。
 * 身份：匿名 device_id（前端 crypto.randomUUID，存 localStorage），无需登录。
 *
 * 「隐藏」语义：用户在本地删除一条记录 = 仅本机不再显示，云端原样保留（hidden=1）。
 * 隐藏集持久化到云端，因此清本地缓存后云端拉取仍会排除该条，达成「与本地解绑」。
 */

const CAP = 50;
let schemaReady = false;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* 幂等补列：隐藏标记。已存在则 ALTER 抛错，catch 忽略。 */
async function ensureSchema(db) {
  if (schemaReady) return;
  try {
    await db.prepare('ALTER TABLE orbs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) { /* 列已存在 */ }
  schemaReady = true;
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const db = env.DB;
  if (!db) return json({ success: true, orbs: [], backend: false });
  const deviceId = new URL(request.url).searchParams.get('device_id') || '';
  if (!deviceId) return json({ success: false, error: 'missing device_id' }, 400);
  await ensureSchema(db);
  const { results } = await db
    .prepare('SELECT at, question, cards, reading, hidden FROM orbs WHERE device_id=? ORDER BY at DESC LIMIT ?')
    .bind(deviceId, CAP)
    .all();
  const orbs = (results || []).map((r) => ({
    at: r.at,
    question: r.question || '',
    cards: safeParse(r.cards, []),
    reading: r.reading || '',
    hidden: r.hidden ? 1 : 0,
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
  await ensureSchema(db);
  /* upsert：同 (device_id,at) 重新解读时只更新内容，保留 hidden 标记（不重置回 0） */
  await db
    .prepare(`INSERT INTO orbs (device_id, at, question, cards, reading) VALUES (?,?,?,?,?)
              ON CONFLICT(device_id, at) DO UPDATE SET
                question=excluded.question, cards=excluded.cards, reading=excluded.reading`)
    .bind(device_id, at, String(question || ''), JSON.stringify(cards), String(reading || ''))
    .run();
  return json({ success: true });
}

/* 「本地删除」的云端落点：标记 hidden=1，记录本身不删（线上一直在）。 */
export async function onRequestPatch(ctx) {
  const { request, env } = ctx;
  const db = env.DB;
  if (!db) return json({ success: false, error: 'no-db' }, 503);
  const u = new URL(request.url);
  const deviceId = u.searchParams.get('device_id') || '';
  const at = u.searchParams.get('at') || '';
  if (!deviceId || !at) return json({ success: false, error: 'invalid' }, 400);
  await ensureSchema(db);
  await db.prepare('UPDATE orbs SET hidden=1 WHERE device_id=? AND at=?').bind(deviceId, at).run();
  return json({ success: true });
}

export async function onRequestDelete(ctx) {
  /* 云端记录刻意不可删：删除只发生在本地 + hidden 标记。这里直接拒绝。 */
  return json({ success: false, error: 'delete-disabled' }, 403);
}

function safeParse(s, fallback) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch (e) { return fallback; }
}
