#!/usr/bin/env node
/**
 * Pingless (dash.pingless.org) 自動保活 + 賺積分腳本
 *
 * 功能:
 *  1. 多賬號支援 (PINGLESS_ACCOUNTS JSON, GitHub Secrets)
 *  2. 每個賬號自動發現所有伺服器, 在續期窗口內 (剩餘 < 24h) 自動續期
 *  3. 每日簽到領取 150 Credits (有得領就領)
 *  4. Telegram Bot 通知報告 (可選)
 *
 * Secrets:
 *  PINGLESS_ACCOUNTS: [{"name":"whfeng578","cookie":"pingless.sid=s%3A..."}, ...]
 *  TG_BOT_TOKEN: Telegram bot token (可選)
 *  TG_CHAT_ID:   Telegram chat id (可選)
 *  FORCE_RENEW:  "1" 時無視窗口強制嘗試續期 (可選, 手動測試用)
 */

const BASE = 'https://dash.pingless.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const FORCE_RENEW = process.env.FORCE_RENEW === '1' || process.env.FORCE_RENEW === 'true';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nowCST() {
  // UTC+8 時間字串
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC+8';
}

async function api(cookie, path, { method = 'GET' } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Cookie': cookie,
      'Accept': 'application/json, text/html, */*',
      'Referer': BASE + '/dashboard',
      'Origin': BASE,
    },
  });
  return res;
}

async function getJSON(cookie, path) {
  const res = await api(cookie, path);
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`AUTH_FAIL (HTTP ${res.status})`);
    err.authFail = true;
    throw err;
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`非 JSON 回應 (HTTP ${res.status}): ${text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
}

/** 從 /servers 頁面 HTML 解析伺服器列表 [{id, name, numeric}] */
function parseServers(html) {
  const map = new Map();
  const re = /\/server\/manage\?id=([a-f0-9]{6,})&(?:amp;)?numeric=(\d+)&(?:amp;)?mode=server'?\s*"?>?\s*>([^<]*)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1], numeric = m[2], rawName = (m[3] || '').trim();
    if (!map.has(id)) map.set(id, { id, numeric, name: rawName || id });
  }
  return [...map.values()];
}

async function listServers(cookie) {
  const res = await api(cookie, '/servers');
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`AUTH_FAIL (HTTP ${res.status})`);
    err.authFail = true;
    throw err;
  }
  const html = await res.text();
  const servers = parseServers(html);
  if (!servers.length && !/server/.test(html)) {
    const err = new Error('無法從 /servers 頁面解析伺服器 (可能 cookie 失效或頁面結構變動)');
    err.authFail = res.status >= 400;
    throw err;
  }
  return servers;
}

async function getBalance(cookie) {
  try {
    const d = await getJSON(cookie, '/api/wallet/balance');
    return typeof d.balance === 'number' ? d.balance : null;
  } catch {
    return null;
  }
}

/** 每日簽到領 Credits。回傳 {claimed, amount, note} */
async function claimDaily(cookie, name) {
  try {
    const ds = await getJSON(cookie, '/api/dailystatus');
    if (ds.text !== '1') {
      return { claimed: false, amount: 0, note: `今日已領取 (連續 ${ds.streak ?? '?'} 天)` };
    }
    const before = await getBalance(cookie);
    const res = await api(cookie, '/api/daily-coins', { method: 'POST' });
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400 && /[?&]err=none/.test(loc)) {
      const after = await getBalance(cookie);
      const amount = before != null && after != null ? Math.max(0, after - before) : (ds.rewardAmount ?? 150);
      return { claimed: true, amount, note: `連續 ${ds.streak ?? '?'} 天` };
    }
    // 有些情況直接回 JSON
    let j = {};
    try { j = JSON.parse(await res.text()); } catch {}
    return { claimed: false, amount: 0, note: `領取失敗: ${esc(j.err || 'HTTP ' + res.status)}` };
  } catch (e) {
    return { claimed: false, amount: 0, note: `簽到異常: ${esc(e.message)}` };
  }
}

/** 續期一台伺服器。回傳 {renewed, note, status} */
async function renewServer(cookie, srv) {
  let st;
  try {
    st = await getJSON(cookie, `/api/server/${srv.id}/renewal/status`);
  } catch (e) {
    return { renewed: false, note: `狀態查詢失敗: ${esc(e.message)}`, status: null };
  }
  const hours = st?.timeRemaining?.hours ?? 0;
  const minutes = st?.timeRemaining?.minutes ?? 0;
  const threshold = st?.config?.warningThreshold ?? 24;
  const remain = `${hours}h${String(minutes).padStart(2, '0')}m`;

  if (st?.hasRenewalBypass) {
    return { renewed: false, note: `Bypass 已啟用, 無需續期`, status: st };
  }
  const inWindow = st?.isExpired || st?.requiresRenewal || hours < threshold;
  if (!inWindow && !FORCE_RENEW) {
    return { renewed: false, note: `剩餘 ${remain} 未達 ${threshold}h 續期窗口`, status: st };
  }

  // 嘗試續期
  try {
    const res = await api(cookie, `/api/server/${srv.id}/renewal/renew`, { method: 'POST' });
    if (res.ok || (res.status >= 300 && res.status < 400)) {
      const st2 = await getJSON(cookie, `/api/server/${srv.id}/renewal/status`).catch(() => null);
      const h2 = st2?.timeRemaining?.hours ?? '?';
      const m2 = String(st2?.timeRemaining?.minutes ?? 0).padStart(2, '0');
      return { renewed: true, note: `續期成功 → 剩餘 ${h2}h${m2}m`, status: st2 };
    }
    let j = {};
    try { j = JSON.parse(await res.text()); } catch {}
    return { renewed: false, note: `續期失敗: ${esc(j.error || 'HTTP ' + res.status)}`, status: st };
  } catch (e) {
    return { renewed: false, note: `續期異常: ${esc(e.message)}`, status: st };
  }
}

/** 處理單一賬號, 回傳 HTML 行陣列 */
async function processAccount(acc) {
  const lines = [];
  const label = acc.name || '(未命名)';
  let cookie = acc.cookie || '';
  if (cookie && !/pingless\.sid=/i.test(cookie)) cookie = 'pingless.sid=' + cookie;
  if (!cookie) {
    return [`❌ <b>${esc(label)}</b>: 缺少 cookie`];
  }

  // 1. 伺服器列表 (驗證 cookie)
  let servers;
  try {
    servers = await listServers(cookie);
    if (Array.isArray(acc.servers) && acc.servers.length) {
      // 配置裡明確指定了 server id 就以配置為準
      const want = new Set(acc.servers);
      const found = servers.filter((s) => want.has(s.id));
      servers = found.length ? found : acc.servers.map((id) => ({ id, numeric: '', name: id }));
    }
  } catch (e) {
    return [`❌ <b>${esc(label)}</b>: ${e.authFail ? 'cookie 已失效, 請重新登入更新 Secret' : esc(e.message)}`];
  }

  // 2. 餘額
  const balance = await getBalance(cookie);
  const balStr = balance != null ? `${balance.toFixed(2)} Credits` : '未知';

  // 3. 每日簽到
  const daily = await claimDaily(cookie, label);

  // 4. 逐台伺服器處理續期
  const srvLines = [];
  if (!servers.length) {
    srvLines.push(`   ⚠️ 此賬號名下沒有伺服器`);
  }
  for (const srv of servers) {
    const r = await renewServer(cookie, srv);
    const icon = r.renewed ? '✅' : 'ℹ️';
    srvLines.push(`   ${icon} ${esc(srv.name)} (${esc(srv.id)}): ${r.note}`);
  }

  lines.push(`👤 <b>${esc(label)}</b>`);
  lines.push(`💰 餘額: ${esc(balStr)}`);
  lines.push(daily.claimed
    ? `🪙 每日簽到: <b>+${esc(daily.amount)} Credits</b> (${esc(daily.note)})`
    : `🪙 每日簽到: ${esc(daily.note)}`);
  lines.push(...srvLines);
  return lines;
}

async function sendTelegram(html) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('[TG] 未配置 TG_BOT_TOKEN / TG_CHAT_ID, 跳過通知');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.ok) {
      console.log(`[TG] 通知發送成功 (message_id=${j.result.message_id})`);
      return true;
    }
    console.error('[TG] 發送失敗:', JSON.stringify(j));
    return false;
  } catch (e) {
    console.error('[TG] 發送異常:', e.message);
    return false;
  }
}

function parseAccounts() {
  const raw = process.env.PINGLESS_ACCOUNTS || '';
  if (!raw.trim()) {
    console.error('環境變數 PINGLESS_ACCOUNTS 未設置');
    process.exit(2);
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    console.error('PINGLESS_ACCOUNTS JSON 解析失敗:', e.message);
    process.exit(2);
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr;
}

async function main() {
  console.log(`=== Pingless 自動保活 ${nowCST()} ${FORCE_RENEW ? '(FORCE_RENEW)' : ''} ===`);
  const accounts = parseAccounts();
  const bodyLines = [`🔄 <b>Pingless 自動保活報告</b>`, `🕐 ${esc(nowCST())}`, ``];
  let hadAuthFail = false;

  for (const acc of accounts) {
    try {
      const lines = await processAccount(acc);
      if (lines.some((l) => l.includes('cookie 已失效'))) hadAuthFail = true;
      bodyLines.push(...lines, ``);
    } catch (e) {
      bodyLines.push(`❌ <b>${esc(acc.name || '(未命名)')}</b>: 處理異常 ${esc(e.message)}`, ``);
      console.error(e);
    }
    await new Promise((r) => setTimeout(r, 1500)); // 賬號間隔, 避免請求過快
  }

  const report = bodyLines.join('\n');
  console.log('---- 報告 (純文本) ----');
  console.log(report.replace(/<[^>]+>/g, ''));
  await sendTelegram(report);
  process.exit(hadAuthFail ? 1 : 0);
}

main().catch((e) => {
  console.error('致命錯誤:', e);
  process.exit(2);
});
