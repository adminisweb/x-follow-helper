'use strict';
/* X 互关助手 · 仪表盘
 *
 * 任务引擎跑在这个页面里；所有对 X 的请求都交给 x.com 标签页里的 content.js 发出。
 * 任务队列、进度、设置、白名单、历史都存在 chrome.storage.local，关掉页面后可以接着跑。
 * 渲染一律用 textContent / createElement，不拼 HTML，X 上的昵称里有什么都不会被当成代码。
 */

/* ================= 工具 ================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const today = () => new Date().toLocaleDateString('sv');
const fmtNum = (n) => (n == null ? '–' : n >= 1e4 ? (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万' : String(n));
const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
const HANDLE_RE = /^\w{1,15}$/;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

const store = {
  get: async (k, d) => { const o = await chrome.storage.local.get(k); return o[k] === undefined ? d : o[k]; },
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: (k) => chrome.storage.local.remove(k),
};

// 用专用 Worker 驱动计时，后台标签页也不会被浏览器限速
const tw = new Worker('timer.js');
let tickWaiters = [];
tw.onmessage = () => { const w = tickWaiters; tickWaiters = []; w.forEach((f) => f()); };
const tick = () => new Promise((r) => tickWaiters.push(r));

async function waitSec(sec, label) {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end && !S.stop) {
    if (label) setStatus(`${label}，还剩 ${Math.ceil((end - Date.now()) / 1000)} 秒`);
    await tick();
  }
}

/* ================= 设置 ================= */

const DEFAULTS = {
  unfollowMin: 30, unfollowMax: 60,
  followMin: 120, followMax: 240,
  batchSize: 5, batchRest: 120, maxRetries: 3,
  dailyUnfollow: 100, dailyFollow: 50,
  graceDays: 7, wlVerified: false, wlMinFollowers: 0,
  skipBotLike: true, followbackVerifiedOnly: false, dryRun: false, notify: true,
  autoHourly: 3, autoDaily: 30, autoDailyMin: 5, autoStartHour: 9, autoEndHour: 23,
};

const GROUPS = [
  { title: '节奏', hint: '每次操作之间会在最小和最大之间随机等待，间隔越长越不容易触发风控。', fields: [
    ['unfollowMin', '取关间隔 最小（秒）', 'num', 5, 3600],
    ['unfollowMax', '取关间隔 最大（秒）', 'num', 5, 3600],
    ['followMin', '回关间隔 最小（秒）', 'num', 5, 3600],
    ['followMax', '回关间隔 最大（秒）', 'num', 5, 3600],
    ['batchSize', '每批数量', 'num', 1, 100],
    ['batchRest', '每批后休息（秒）', 'num', 0, 7200],
    ['maxRetries', '失败最大重试次数', 'num', 0, 10],
  ] },
  { title: '每日上限', hint: '0 表示不限制。达到上限后任务会停下，明天可以接着跑。试运行不计入。', fields: [
    ['dailyUnfollow', '每日取关上限', 'num', 0, 5000],
    ['dailyFollow', '每日回关上限', 'num', 0, 5000],
  ] },
  { title: '保护规则', hint: '前三项只影响取关，后两项只影响回关。白名单本身在“白名单”页管理。', fields: [
    ['graceDays', '新关注的宽限期（天，0 为关闭）', 'num', 0, 365],
    ['wlVerified', '不取关认证账号（蓝 V）', 'bool'],
    ['wlMinFollowers', '不取关粉丝数不少于（0 为关闭）', 'num', 0, 1e9],
    ['followbackVerifiedOnly', '回关时只回关付费蓝 V 账号', 'bool'],
    ['skipBotLike', '回关时跳过疑似营销号', 'bool'],
  ] },
  { title: '全自动模式', hint: '只自动回关，取关永远手动。每天的数量在“最少”和“最多”之间随机，偏向较少，偶尔整天休息；每天分 1 到 3 个时段，每段 40 到 100 分钟，时段之外不做任何操作。回关间隔不低于 120 秒、每天不超过 50 个、每小时不超过 5 个，设置页里更激进的数字对它无效。需要保持仪表盘页面和 x.com 标签页开着。', fields: [
    ['autoDailyMin', '每天最少回关（个）', 'num', 0, 50],
    ['autoDaily', '每天最多回关（个）', 'num', 1, 50],
    ['autoHourly', '每小时最多回关（个）', 'num', 1, 5],
    ['autoStartHour', '最早开始时间（点）', 'num', 0, 23],
    ['autoEndHour', '最晚结束时间（点）', 'num', 1, 24],
  ] },
  { title: '提醒', hint: '任务跑完、被中断或触发限流时，如果你不在这个页面，会弹出系统通知并改写标签页标题。第一次点开始时浏览器会询问通知权限。', fields: [
    ['notify', '任务结束时提醒我', 'bool'],
  ] },
  { title: '试运行', hint: '打开后只走完整流程并写入记录，不会真正关注或取关。第一次使用建议先试一遍。', fields: [
    ['dryRun', '只模拟，不真正关注或取关', 'bool'],
  ] },
];

/* ================= 状态 ================= */

const S = {
  settings: { ...DEFAULTS },
  whitelist: [], wlIdx: { ids: new Set(), hs: new Set() }, wlRev: 0,
  forced: new Set(), scan: null, scanMap: new Map(), stats: { a: 0, m: 0, b: 0, bBlue: 0, followers: 0, following: 0 },
  firstSeen: {}, daily: null, history: [], queue: null, cooldown: null,
  auto: { enabled: false, nextRun: 0, pausedUntil: 0, needsManual: false, stopReason: '', strikes: [], capHalfDate: null, ignored: {}, cache: {}, lastCycle: null, unfollowable: null },
  running: false, scanning: false, stop: false, scanDirty: false, autoBusy: false,
};
let mode = 'unfollow';                 // 界面模式：unfollow | followback
let cand = { list: [], skipped: {} };
const selected = new Set();
const hSel = new Set();
const formInputs = {};
let isPrimary = false;                 // 只有拿到跨标签页锁的页面才能执行任务
const TAB_KEY = 'xfh_dashboard_tab';

/* ================= 单实例锁 ================= */

// 两个仪表盘同时跑会重复取关/回关，还会互相覆盖 history/queue。
// Web Locks 在同一扩展的多个标签页之间是共享的；锁跟着页面生命周期释放。
function showSecondaryMask() {
  const mask = $('#lockMask');
  if (mask) mask.hidden = false;
  document.title = '（只读）X 互关助手';
}

async function claimEngine() {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') {
    isPrimary = true;                   // 老浏览器不支持时退化为原来的行为
    return true;
  }
  const got = await new Promise((resolve) => {
    try {
      navigator.locks.request('xfh-engine', { ifAvailable: true }, async (lock) => {
        if (!lock) { resolve(false); return; }
        isPrimary = true;
        resolve(true);
        await new Promise(() => {});    // 一直持有，页面关闭时自动释放
      }).catch(() => { isPrimary = true; resolve(true); });
    } catch (_) {
      isPrimary = true;                 // 锁 API 异常时也不要让页面不可用
      resolve(true);
    }
  });
  if (!got) {
    showSecondaryMask();
    // 等另一个仪表盘关闭后刷新接管，避免两个页面同时操作
    navigator.locks.request('xfh-engine', () => { location.reload(); }).catch(() => {});
    log('已有另一个仪表盘在运行，这个页面只读；关闭另一个页面后会自动接管。', 'warn');
  }
  return got;
}

/* ================= 日志 / 状态栏 ================= */

function log(msg, cls = '') {
  const box = $('#log');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  box.append(el('div', { class: 'ln ' + cls }, el('time', { text: t }), el('span', { text: msg })));
  while (box.childElementCount > 500) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function setStatus(t) { $('#status').textContent = t; }

/* ================= 与 x.com 标签页通信 ================= */

const X_URLS = ['https://x.com/*', 'https://twitter.com/*'];

function withTimeout(promise, ms, code) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(code)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// timeoutMs 必须覆盖 content.js 里最慢的操作（discover / ids / probe），
// 不然内容脚本还在下载 X 的前端 bundle 时，页面会一直卡在“开始扫描……”没有任何反馈。
async function call(msg, timeoutMs = 60000) {
  const tabs = await chrome.tabs.query({ url: X_URLS });
  if (!tabs.length) throw new Error('NO_TAB');
  let timedOut = false;
  for (const t of tabs) {
    try { return await withTimeout(chrome.tabs.sendMessage(t.id, { xfh: 1, ...msg }), timeoutMs, 'TIMEOUT'); }
    catch (e) { if (e && e.message === 'TIMEOUT') timedOut = true; }
  }
  if (timedOut) throw new Error('TIMEOUT');
  throw new Error('NO_CS');
}

function connMsg(e) {
  if (e && e.message === 'NO_TAB') return '没有找到已打开的 x.com 标签页，请先打开 x.com 并登录。';
  if (e && e.message === 'NO_CS') return '找到了 x.com 标签页，但它还没有加载扩展脚本，请刷新那个标签页后重试。';
  if (e && e.message === 'TIMEOUT') return 'x.com 标签页长时间没有响应（可能正在加载 X 的接口代码）。请等一会儿再试，或刷新那个标签页。';
  return String((e && e.message) || e);
}

function errText(r) {
  const m = r.message || '请求失败';
  if (!r.status || m.includes('HTTP ' + r.status)) return m + (r.code ? `（code ${r.code}）` : '');
  return `${m}（HTTP ${r.status}${r.code ? `，code ${r.code}` : ''}）`;
}

async function checkConn() {
  const a = $('#acct');
  try {
    const p = await call({ op: 'ping' });
    if (p && p.me) {
      a.textContent = p.handle ? `已连接 @${p.handle}` : `已连接（用户 ID ${p.me}）`;
      a.className = 'acct ok';
      return p;
    }
    a.textContent = '已找到 X 标签页，但没有读到登录信息';
    a.className = 'acct bad';
  } catch (e) {
    a.textContent = connMsg(e);
    a.className = 'acct bad';
  }
  return null;
}

/* ================= 白名单 ================= */

function rebuildWl() {
  S.wlIdx = {
    ids: new Set(S.whitelist.filter((w) => w.id).map((w) => w.id)),
    hs: new Set(S.whitelist.map((w) => String(w.h || '').toLowerCase()).filter(Boolean)),
  };
  $('#wlCount').textContent = S.whitelist.length;
}
const inWhitelist = (u) => S.wlIdx.ids.has(u.id) || S.wlIdx.hs.has(String(u.h || '').toLowerCase());

const WL_BACKUP = 'xfh_whitelist_backup';
const WL_REV_KEY = 'xfh_whitelist_rev';
let wlSaveChain = Promise.resolve();

function writeWlBackup(rev) {
  try { localStorage.setItem(WL_BACKUP, JSON.stringify({ rev, list: S.whitelist })); } catch (_) { /* ignore */ }
}

function readWlBackup() {
  try {
    const raw = JSON.parse(localStorage.getItem(WL_BACKUP) || 'null');
    if (Array.isArray(raw)) return { rev: 0, list: sanitizeWhitelist(raw) };   // 旧格式
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.list)) return { rev: 0, list: [] };
    return { rev: Number(raw.rev) || 0, list: sanitizeWhitelist(raw.list) };
  } catch (_) { return { rev: 0, list: [] }; }
}

// 先同步写 localStorage 备份，再写 chrome.storage；rev 用来判断哪份更新。
// 即使添加后立刻关掉页面（chrome.storage 的异步写入还没落地），下次打开也能从备份恢复。
async function saveWl() {
  S.wlRev = Math.max(Date.now(), (S.wlRev || 0) + 1);
  writeWlBackup(S.wlRev);
  const snapshot = S.whitelist.slice();
  const rev = S.wlRev;
  wlSaveChain = wlSaveChain
    .catch(() => {})
    .then(() => chrome.storage.local.set({ xfh_whitelist: snapshot, [WL_REV_KEY]: rev }));
  try {
    await wlSaveChain;
    return true;
  } catch (e) {
    log('白名单保存失败：' + ((e && e.message) || e), 'err');
    return false;
  }
}

function newerWl(stored, storedRev) {
  const saved = sanitizeWhitelist(stored);
  const backup = readWlBackup();
  const rev = Number(storedRev) || 0;
  // 备份 rev 更新就用备份，即使它是空数组（用户可能刚移除了最后一个人）
  return backup.rev > rev
    ? { list: backup.list, rev: backup.rev, fromBackup: true }
    : { list: saved, rev, fromBackup: false };
}

async function loadStoredWl() {
  try {
    const o = await chrome.storage.local.get(['xfh_whitelist', WL_REV_KEY]);
    return newerWl(o.xfh_whitelist, o[WL_REV_KEY]).list;
  } catch (_) { return []; }
}

async function initWl(stored, storedRev) {
  const pick = newerWl(stored, storedRev);
  S.wlRev = pick.rev;
  // 备份比 storage 新（例如写完备份后页面立刻关闭），用备份恢复并补写 storage
  if (pick.fromBackup) {
    try { await chrome.storage.local.set({ xfh_whitelist: pick.list, [WL_REV_KEY]: pick.rev }); } catch (_) {}
    if (pick.list.length) log(`已从本地备份恢复 ${pick.list.length} 个白名单账号`, 'warn');
  } else {
    try { localStorage.setItem(WL_BACKUP, JSON.stringify({ rev: S.wlRev, list: pick.list })); } catch (_) {}
  }
  return pick.list;
}

const wlKey = (w) => {
  const h = String((w && w.h) || '').replace(/^@/, '').toLowerCase();
  return h ? 'h:' + h : 'id:' + (w && w.id);
};

async function addToWl(users) {
  // 读一次最新 storage，避免用这个页面里过期的 S.whitelist 覆盖别的标签页刚加的人
  const stored = await loadStoredWl();
  const map = new Map();
  for (const w of [...stored, ...S.whitelist]) {
    if (!w || (!w.id && !w.h)) continue;
    const k = wlKey(w);
    const prev = map.get(k);
    // 同名条目优先保留有 ID 的那份（扫描补全过 ID 的内存副本）
    if (!prev || (!prev.id && w.id)) map.set(k, w);
  }
  let n = 0;
  for (const u of users) {
    const h = String((u && u.h) || '').replace(/^@/, '').trim();
    if (!h) continue;
    const w = { id: u.id || null, h, n: u.n || h, a: u.a || '', at: Date.now() };
    const k = wlKey(w);
    if (map.has(k)) continue;
    map.set(k, w);
    n++;
  }
  S.whitelist = [...map.values()];
  rebuildWl();
  const ok = await saveWl();
  return { n, ok };
}

// x.com 上不是用户名的保留路径；粘贴状态页/首页链接时不要把它们加进白名单
const RESERVED_PATHS = new Set([
  'i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose',
  'login', 'logout', 'signup', 'account', 'tos', 'privacy', 'about', 'jobs', 'help',
  'lists', 'bookmarks', 'communities', 'premium', 'verified', 'intent', 'share',
  'hashtag', 'following', 'followers', 'topics', 'places', 'download', 'oauth', 'mobile',
]);

function parseHandles(text) {
  return [...new Set(String(text).split(/[\s,，;；]+/)
    .map((t) => t.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, ''))
    .filter((t) => HANDLE_RE.test(t) && !RESERVED_PATHS.has(t.toLowerCase())))];
}

function backfillWl() {
  if (!S.scan) return;
  const byHandle = new Map(S.scan.following.map((u) => [u.h.toLowerCase(), u]));
  let changed = false;
  for (const w of S.whitelist) {
    const u = !w.id && byHandle.get(w.h.toLowerCase());
    if (u) { w.id = u.id; w.n = u.n; w.a = u.a; changed = true; }
  }
  // 只更新内存里的 ID/昵称；不要在这里整份保存，避免扫描时用旧列表覆盖 storage
  if (changed) rebuildWl();
}

function renderWl() {
  const q = $('#wlSearch').value.trim().toLowerCase();
  const box = $('#wlList');
  box.replaceChildren();
  const items = [...S.whitelist].sort((a, b) => b.at - a.at)
    .filter((w) => !q || w.h.toLowerCase().includes(q) || String(w.n || '').toLowerCase().includes(q));
  if (!items.length) { box.append(el('div', { class: 'empty', text: S.whitelist.length ? '没有匹配的账号' : '白名单是空的' })); return; }
  for (const w of items) {
    box.append(el('div', { class: 'wlitem' },
      el('div', { class: 'who' }, avatar(w), el('div', {},
        el('a', { href: `https://x.com/${w.h}`, target: '_blank', rel: 'noopener noreferrer', text: w.n || w.h }),
        el('span', { class: 'h', text: '@' + w.h + (w.id ? '' : '（下次扫描后补全 ID）') }))),
      el('button', { class: 'btn quiet sm', text: '移除', onclick: async () => {
        await removeFromWl(w);
      } })));
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ================= 扫描 ================= */

async function fetchAll(kind, label, via) {
  const out = new Map();
  let cursor = null, page = 0, rateRetry = 0;
  while (!S.stop) {
    page++;
    let r;
    try { r = await call({ op: 'list', kind, cursor, via: via || '' }); } catch (e) { throw new Error(connMsg(e)); }
    if (!r.ok) {
      if (r.kind === 'rate' && rateRetry < 3) {
        rateRetry++; page--;
        log(`触发限流，等待 60 秒后重试（${rateRetry}/3）`, 'warn');
        await waitSec(60, '限流等待');
        continue;
      }
      throw new Error(errText(r));
    }
    const before = out.size;
    for (const u of r.users) out.set(u.id, u);
    const added = out.size - before;
    log(`第 ${page} 页：发现 ${r.users.length} 个${label}（累计 ${out.size}）` +
      (page === 1 && r.meta ? `  [${r.meta.path}，下一页游标：${r.meta.rawNext || '无'}]` : ''), page === 1 && r.meta ? 'dim' : '');
    if (page > 1 && added === 0) {
      log(`第 ${page} 页没有新的${label}，停止这条翻页`, 'warn');
      break;
    }
    if (!r.next || r.next === cursor || !r.users.length || page > 400) break;
    cursor = r.next;
    await waitSec(rand(1.5, 3), '翻页');
  }
  return [...out.values()];
}

function stubUser(id) {
  return { id: String(id), h: String(id), n: '资料未补全', incomplete: true, fo: null, fi: null, t: null, a: '' };
}

function mergeById(base, extra) {
  const m = new Map();
  for (const u of base) if (u && u.id) m.set(u.id, u);
  for (const u of extra) {
    if (!u || !u.id) continue;
    const prev = m.get(u.id);
    if (!prev || (prev.incomplete && !u.incomplete)) m.set(u.id, u);
  }
  return [...m.values()];
}

function missingIds(list, ids) {
  const have = new Set(list.map((u) => u.id));
  return ids.filter((id) => !have.has(id));
}

// REST 翻页停住时，用 GraphQL 从头再扫一遍。数字游标不能沿用。
async function rescanGql(kind, label, got, expect) {
  log(`${label}详情只扫到 ${got.length}/${expect}，改用 GraphQL 从头翻页……`, 'warn');
  try {
    const more = await fetchAll(kind, label, 'gql');
    const merged = mergeById(got, more);
    log(`GraphQL 得到 ${more.length} 个${label}，合并后 ${merged.length} 个`, merged.length > got.length ? 'ok' : 'warn');
    return merged.length >= got.length ? merged : got;
  } catch (e) {
    log(`GraphQL 扫描${label}失败：${e.message}`, 'warn');
    return got;
  }
}

// 详情列表缺人时：先抄另一份名单里已有的资料，再按 ID 补。失败也保留已经对上的，剩下的用占位。
async function repairList(list, ids, other) {
  const have = new Set(list.map((u) => u.id));
  const omap = new Map(other.filter((u) => u && !u.incomplete).map((u) => [u.id, u]));
  const out = [...list];
  const need = [];
  for (const id of ids) {
    if (have.has(id)) continue;
    if (omap.has(id)) { out.push(omap.get(id)); have.add(id); }
    else need.push(id);
  }
  log(`ID 列表共 ${ids.length} 个，还缺资料的 ${need.length} 个`);
  const idSet = new Set(ids);
  let lookupErr = null;
  for (let i = 0; i < need.length && !S.stop; i += 100) {
    let lr;
    try { lr = await call({ op: 'lookup', ids: need.slice(i, i + 100) }); }
    catch (e) { lookupErr = connMsg(e); break; }
    if (!lr || !lr.ok) { lookupErr = errText(lr || { message: '请求失败' }); break; }
    for (const u of lr.users || []) if (u && idSet.has(u.id) && !have.has(u.id)) { out.push(u); have.add(u.id); }
    log(`补充资料 ${Math.min(i + 100, need.length)} / ${need.length}` + (lr.via ? `（${lr.via}）` : ''));
    if (i + 100 < need.length) await waitSec(rand(1, 2), '补充资料');
  }
  let stubs = 0;
  for (const id of ids) {
    if (have.has(id)) continue;
    out.push(stubUser(id));
    have.add(id);
    stubs++;
  }
  if (lookupErr) log(`有一部分资料没补上：${lookupErr}` + (stubs ? `，已保留 ${stubs} 个占位` : ''), 'warn');
  else if (stubs) log(`还有 ${stubs} 个没有资料，已放入名单但不会自动操作`, 'warn');
  return out;
}

async function scan() {
  if (!isPrimary) { log('另一个仪表盘正在运行，这个页面只读。', 'warn'); return; }
  if (S.running || S.scanning || S.autoBusy) return;
  S.scanning = true; S.stop = false; updateUI();
  try {
    const ping = await call({ op: 'ping' }).catch((e) => { throw new Error(connMsg(e)); });
    if (!ping.me) throw new Error('没有读到登录信息，请确认 x.com 标签页已登录。');
    log('开始扫描……');
    let followers = await fetchAll('followers', '粉丝');
    let following = S.stop ? [] : await fetchAll('following', '关注');
    if (S.stop) { log('扫描已取消，未保存结果', 'warn'); return; }

    // 完整性核对：以“只返回 ID”的列表为基准（不依赖资料接口，也不受分页截断影响）
    let warn = null;
    const short = (got, exp) => exp > 0 && got < exp * 0.97 && exp - got >= 3;
    const idsOf = async (kind) => {
      const r = await call({ op: 'ids', kind }, 180000).catch((e) => ({ ok: false, message: connMsg(e) }));
      return r && r.ok && Array.isArray(r.ids) ? r.ids : null;
    };
    const fiIds = await idsOf('following');
    const foIds = fiIds ? await idsOf('followers') : null;
    let expFollowing = null, expFollowers = null;
    if (fiIds && foIds) {
      expFollowing = fiIds.length; expFollowers = foIds.length;
      log(`ID 列表核对：关注 ${fiIds.length}、粉丝 ${foIds.length}；列表扫描到：关注 ${following.length}、粉丝 ${followers.length}`);
    } else {
      log('没能取到 ID 列表，改用 X 资料里的总数核对', 'dim');
      try {
        const m = await call({ op: 'me' });
        if (m.ok) { expFollowing = m.following; expFollowers = m.followers; log(`X 资料显示：粉丝 ${m.followers}，关注 ${m.following}`); }
        else log('也没法读取 X 资料里的总数，无法核对扫描是否完整：' + errText(m), 'warn');
      } catch (e) { log('也没法读取 X 资料里的总数：' + connMsg(e), 'warn'); }
    }
    if (S.stop) { log('扫描已取消，未保存结果', 'warn'); return; }
    if (fiIds && short(following.length, fiIds.length)) following = await rescanGql('following', '关注', following, fiIds.length);
    if (S.stop) { log('扫描已取消，未保存结果', 'warn'); return; }
    if (foIds && short(followers.length, foIds.length)) followers = await rescanGql('followers', '粉丝', followers, foIds.length);
    if (S.stop) { log('扫描已取消，未保存结果', 'warn'); return; }
    if (fiIds && missingIds(following, fiIds).length) {
      log(`关注还有 ${missingIds(following, fiIds).length} 个不在详情里，按 ID 补全……`, 'warn');
      following = await repairList(following, fiIds, followers);
      log(`补全后共 ${following.length} 个关注`, 'ok');
    }
    if (foIds && missingIds(followers, foIds).length) {
      log(`粉丝还有 ${missingIds(followers, foIds).length} 个不在详情里，按 ID 补全……`, 'warn');
      followers = await repairList(followers, foIds, following);
      log(`补全后共 ${followers.length} 个粉丝`, 'ok');
    }
    if (S.stop) { log('扫描已取消，未保存结果', 'warn'); return; }
    const fset = new Set(foIds || followers.map((u) => u.id));
    const gset = new Set(fiIds || following.map((u) => u.id));
    const countTargets = [];
    for (const u of following) if (u && !u.incomplete && !fset.has(u.id)) countTargets.push(u);
    for (const u of followers) if (u && !u.incomplete && !gset.has(u.id)) countTargets.push(u);
    await fillCounts(countTargets);
    if (S.stop) { log('扫描已取消，未保存结果', 'warn'); return; }
    const parts = [];
    const incompleteN = (users) => users.filter((u) => u.incomplete).length;
    const incFi = incompleteN(following), incFo = incompleteN(followers);
    if (incFi) parts.push(`关注里 ${incFi} 个没有资料`);
    if (incFo) parts.push(`粉丝里 ${incFo} 个没有资料`);
    if (!fiIds && short(following.length, expFollowing)) parts.push(`关注只扫到 ${following.length}/${expFollowing}`);
    if (!foIds && short(followers.length, expFollowers)) parts.push(`粉丝只扫到 ${followers.length}/${expFollowers}`);
    if (parts.length) { warn = parts.join('，'); log('扫描结果可能不完整：' + warn, 'warn'); }

    const now = Date.now();
    const first = Object.keys(S.firstSeen).length === 0;
    const gids = new Set(fiIds || following.map((u) => u.id));
    let newly = 0;
    for (const id of gids) if (!(id in S.firstSeen)) { S.firstSeen[id] = first ? 0 : now; newly++; }
    for (const id of Object.keys(S.firstSeen)) if (!gids.has(id)) delete S.firstSeen[id];
    if (!first && newly && S.settings.graceDays > 0) {
      log(`这次新计入本地记录的关注有 ${newly} 个。宽限期 ${S.settings.graceDays} 天内，他们不会进入取关名单。`, 'dim');
    }

    S.scan = {
      at: now, me: ping.me, handle: ping.handle, followers, following, warn,
      followingIds: fiIds || undefined, followerIds: foIds || undefined,
    };
    S.forced.clear();
    rebuildScanMap(); computeStats(); backfillWl();
    await Promise.all([store.set('xfh_scan', S.scan), store.set('xfh_firstSeen', S.firstSeen)]);

    const flagged = followers.filter((u) => u.b !== undefined).length;
    if (followers.length && !flagged) log('提示：这次扫描用的接口没有返回付费蓝 V 标记，“只回关付费蓝 V”暂时无法使用。', 'warn');
    else if (followers.length) log(`粉丝里带付费蓝 V 标记的有 ${followers.filter((u) => u.b === true).length} 个`);
    log(`粉丝总数：${S.stats.followers}`, 'ok');
    log(`其中已回关 ${S.stats.m} 个，待回关 ${S.stats.b} 个，待回关蓝 V ${S.stats.bBlue} 个`);
    log(`关注中 ${S.stats.following} 个，其中没有回关你的 ${S.stats.a} 个`, 'ok');
    recompute(false); renderAll(); checkConn();
  } catch (e) {
    log('扫描失败：' + e.message, 'err');
    setStatus('扫描失败');
  } finally {
    S.scanning = false; updateUI();
  }
}

function rebuildScanMap() {
  S.scanMap = new Map();
  if (!S.scan) return;
  for (const u of S.scan.followers) S.scanMap.set(u.id, u);
  for (const u of S.scan.following) S.scanMap.set(u.id, u);
}

function idList(sc, key, users) {
  if (sc && Array.isArray(sc[key]) && sc[key].length) return sc[key].map(String);
  return (users || []).map((u) => u.id);
}

function needsCounts(u) {
  return u && u.id && !u.incomplete && (u.fo == null || u.fi == null || u.t == null);
}

// 名单里缺粉丝 / 关注 / 帖子数时，按 ID 再查一次资料，只补这三个数字
async function fillCounts(users) {
  const need = [];
  const seen = new Set();
  for (const u of users) {
    if (!needsCounts(u) || seen.has(u.id)) continue;
    seen.add(u.id);
    need.push(u);
  }
  if (!need.length) return;
  log(`有 ${need.length} 个账号缺少粉丝、关注或帖子数，正在补全……`, 'warn');
  const byId = new Map(need.map((u) => [u.id, u]));
  for (let i = 0; i < need.length && !S.stop; i += 100) {
    let lr;
    try { lr = await call({ op: 'lookup', ids: need.slice(i, i + 100).map((u) => u.id) }); }
    catch (e) { log('补全数字失败：' + connMsg(e), 'warn'); break; }
    if (!lr || !lr.ok) { log('补全数字失败：' + errText(lr || { message: '请求失败' }), 'warn'); break; }
    for (const u of lr.users || []) {
      const dst = byId.get(u.id);
      if (!dst) continue;
      if (dst.fo == null && u.fo != null) dst.fo = u.fo;
      if (dst.fi == null && u.fi != null) dst.fi = u.fi;
      if (dst.t == null && u.t != null) dst.t = u.t;
    }
    log(`补全数字 ${Math.min(i + 100, need.length)} / ${need.length}` + (lr.via ? `（${lr.via}）` : ''));
    if (i + 100 < need.length) await waitSec(rand(1, 2), '补全数字');
  }
  const still = need.filter(needsCounts).length;
  if (still) log(`还有 ${still} 个账号没有粉丝、关注或帖子数`, 'warn');
}

function computeStats() {
  const sc = S.scan;
  if (!sc) { S.stats = { a: 0, m: 0, b: 0, bBlue: 0, followers: 0, following: 0 }; return; }
  const f = new Set(idList(sc, 'followerIds', sc.followers));
  const g = new Set(idList(sc, 'followingIds', sc.following));
  const byFollower = new Map();
  for (const u of sc.followers || []) if (u && u.id) byFollower.set(u.id, u);
  let m = 0, bBlue = 0;
  for (const id of g) if (f.has(id)) m++;
  for (const id of f) {
    if (g.has(id)) continue;
    const u = byFollower.get(id);
    if (u && u.b === true) bBlue++;
  }
  S.stats = { followers: f.size, following: g.size, m, a: g.size - m, b: f.size - m, bBlue };
}

/* ================= 候选名单 ================= */

function protectedReason(u) {
  if (inWhitelist(u)) return 'wl';
  if (S.settings.wlVerified && u.v) return 'verified';
  if (S.settings.wlMinFollowers > 0 && (u.fo || 0) >= S.settings.wlMinFollowers) return 'big';
  return null;
}
function reasonText(why) {
  return ({
    wl: '在白名单中',
    verified: '认证账号（可在设置里关掉这条规则）',
    big: `粉丝数不少于 ${S.settings.wlMinFollowers}`,
    grace: `刚关注不久（宽限期 ${S.settings.graceDays} 天）`,
    incomplete: '资料还没补全，重新扫描后才会进入名单',
  })[why] || why;
}

const isBotLike = (u) => u.t === 0 || (u.d && u.t != null && u.t < 5);

function profileById(users) {
  const m = new Map();
  for (const u of users || []) if (u && u.id) m.set(u.id, u);
  return m;
}

function unfollowCandidates() {
  const sc = S.scan;
  const fset = new Set(idList(sc, 'followerIds', sc.followers));
  const gids = idList(sc, 'followingIds', sc.following);
  const byId = profileById(sc.following);
  const list = [], excluded = [], skipped = { wl: 0, verified: 0, big: 0, grace: 0, incomplete: 0 };
  const graceMs = S.settings.graceDays * 864e5;
  for (const id of gids) {
    if (fset.has(id)) continue;
    const u = byId.get(id) || stubUser(id);
    if (u.incomplete && !S.forced.has(id)) { skipped.incomplete++; excluded.push({ u, why: 'incomplete' }); continue; }
    let why = protectedReason(u);
    if (!why) {
      const seen = S.firstSeen[u.id] || 0;
      if (graceMs > 0 && seen && Date.now() - seen < graceMs) why = 'grace';
    }
    // 被你点了“仍然取关”的账号放回名单；白名单永远不能被覆盖
    if (why && !(why !== 'wl' && S.forced.has(u.id))) { skipped[why]++; excluded.push({ u, why }); continue; }
    list.push(u);
  }
  return { list, skipped, excluded };
}

function followbackCandidates() {
  const sc = S.scan;
  const gset = new Set(idList(sc, 'followingIds', sc.following));
  const fids = idList(sc, 'followerIds', sc.followers);
  const byId = profileById(sc.followers);
  const list = [], skipped = { unverified: 0, bot: 0, incomplete: 0, stale: false };
  const profiles = fids.map((id) => byId.get(id)).filter((u) => u && !u.incomplete);
  // 旧版扫描数据没有付费蓝 V 标记（b），这时不能凭空判断，提示重新扫描
  skipped.stale = S.settings.followbackVerifiedOnly && profiles.length > 0 &&
    profiles.every((u) => u.b === undefined);
  if (skipped.stale) return { list, skipped };
  for (const id of fids) {
    if (gset.has(id)) continue;
    const u = byId.get(id) || stubUser(id);
    if (u.incomplete) { skipped.incomplete++; continue; }
    if (S.settings.followbackVerifiedOnly && u.b !== true) { skipped.unverified++; continue; }
    if (S.settings.skipBotLike && isBotLike(u)) { skipped.bot++; continue; }
    list.push(u);
  }
  return { list, skipped };
}

function recompute(keepSel) {
  const prev = new Set(selected);
  selected.clear();
  if (!S.scan) { cand = { list: [], skipped: {} }; return; }
  cand = mode === 'unfollow' ? unfollowCandidates() : followbackCandidates();
  // 只有明确保留选择时才恢复旧勾选；新出现的候选一律不默认勾选。
  // 取关是破坏性操作，扫描完默认全选太容易误点。
  if (keepSel) for (const u of cand.list) if (prev.has(u.id)) selected.add(u.id);
}

/* ================= 渲染 ================= */

function avatar(u) {
  return u.a && u.a.startsWith('https://')
    ? el('img', { src: u.a, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : el('span', { class: 'ph' });
}

function badges(u) {
  const out = [];
  if (u.b) out.push(el('span', { class: 'chip v', text: '蓝 V' }));
  else if (u.v) out.push(el('span', { class: 'chip', text: '旧版认证' }));
  if (u.p) out.push(el('span', { class: 'chip l', text: '已锁推' }));
  if (u.d) out.push(el('span', { class: 'chip', text: '默认头像' }));
  return out;
}

function renderStats() {
  const { a, m, b, bBlue, followers, following } = S.stats;
  $('#sFollowers').textContent = followers; $('#sFollowing').textContent = following;
  $('#sNotBack').textContent = a; $('#sMutual').textContent = m; $('#sFans').textContent = b;
  $('#sFansBlue').textContent = S.scan ? `待回关蓝 V ${bBlue || 0}` : '';
  const total = a + m + b;
  $('#stripEmpty').hidden = total > 0;
  for (const [id, v] of [['segA', a], ['segM', m], ['segB', b]]) {
    const s = $('#' + id);
    s.style.flex = `${v} 1 0`;
    s.style.minWidth = v > 0 ? '6px' : '0';
    s.style.display = v > 0 ? '' : 'none';
  }
  const pct = (x) => (total ? (x / total) * 100 : 0);
  const top = $('#brkFollowing'), bot = $('#brkFans');
  top.hidden = bot.hidden = total === 0;
  top.style.left = '0'; top.style.width = pct(a + m) + '%';
  bot.style.left = pct(a) + '%'; bot.style.width = pct(m + b) + '%';
  const exN = S.scan ? unfollowCandidates().excluded.length : 0;
  $('#sNotBackSub').textContent = exN ? `其中 ${exN} 个被保护规则排除` : '';
  $('#scanInfo').textContent = S.scan
    ? `上次扫描：${fmtTime(S.scan.at)}` + (S.scan.warn ? `。列表可能不完整：${S.scan.warn}` : '')
    : '尚未扫描';
  $('#scanInfo').classList.toggle('warnt', !!(S.scan && S.scan.warn));
}

// 搜索不到时说明原因，而不是只说“没有匹配”
function explainMiss(q) {
  const key = q.toLowerCase().replace(/^@/, '');
  let hit = null;
  for (const u of S.scanMap.values()) if (u.h.toLowerCase() === key) { hit = u; break; }
  if (!hit) for (const u of S.scanMap.values()) if (u.h.toLowerCase().includes(key) || String(u.n || '').toLowerCase().includes(key)) { hit = u; break; }
  if (!hit) return '这次扫描的结果里没有这个账号：可能是扫描之后才关注或取关的，也可能是列表没扫全。可以重新扫描一次。';
  const inFollowing = idList(S.scan, 'followingIds', S.scan.following).includes(hit.id);
  const inFollowers = idList(S.scan, 'followerIds', S.scan.followers).includes(hit.id);
  const name = hit.incomplete ? `这个账号（ID ${hit.id}）` : '@' + hit.h;
  if (hit.incomplete) return `${name} 的资料还没补全，所以没有放进可操作名单。重新扫描后如果补上了资料，会按规则重新归类。`;
  if (inFollowing && inFollowers) return `${name} 和你互相关注，所以不在${mode === 'unfollow' ? '取关' : '回关'}名单里。`;
  if (inFollowing) {
    const ex = (cand.excluded || []).find((x) => x.u.id === hit.id);
    if (mode !== 'unfollow') return `${name} 是你关注了、但没有回关你的人，请切换到“取关未回关的人”查看。`;
    return ex ? `${name} 你关注了他、他没有回关，但被“${reasonText(ex.why)}”排除了，可以在下方“已排除的账号”里处理。`
              : `${name} 应该在取关名单里，请清空搜索框重试。`;
  }
  if (inFollowers) {
    if (mode === 'unfollow') return `${name} 关注了你，但你还没有关注他，请切换到“回关未关注的人”查看。`;
    if (S.settings.followbackVerifiedOnly && hit.b !== true) return `${name} 关注了你，但不是付费蓝 V，被“只回关付费蓝 V”过滤了。`;
    if (S.settings.skipBotLike && isBotLike(hit)) return `${name} 关注了你，但被判断为疑似营销号，被过滤了。`;
    return `${name} 应该在回关名单里，请清空搜索框重试。`;
  }
  return `${name} 在扫描数据里，但现在既没有关注你，你也没有关注他。`;
}

// 已排除的账号：逐个说明原因，并允许处理
function renderExcluded() {
  const box = $('#excl');
  const ex = mode === 'unfollow' && cand.excluded ? cand.excluded : [];
  box.hidden = !ex.length;
  if (!ex.length) return;
  const q = $('#q').value.trim().toLowerCase().replace(/^@/, '');
  const rows = ex.filter(({ u }) => !q || u.h.toLowerCase().includes(q) || String(u.n || '').toLowerCase().includes(q));
  if (q && rows.length) box.open = true;
  $('#exclSum').textContent = `已排除的账号（${ex.length} 个）`;
  $('#exclNote').textContent = '这些账号没有回关你，但被保护规则挡住了，不会被取关。' + (rows.length < ex.length ? `当前搜索匹配 ${rows.length} 个。` : '');
  const list = $('#exclList');
  list.replaceChildren();
  for (const { u, why } of rows.slice(0, 300)) {
    const acts = why === 'wl'
      ? [el('button', { class: 'btn quiet sm', text: '移出白名单', onclick: () => removeFromWl(u) })]
      : [el('button', { class: 'btn quiet sm', text: '仍然取关', onclick: () => forceUnfollow(u) }),
         el('button', { class: 'btn quiet sm', text: '加入白名单', onclick: async () => {
           const r = await addToWl([u]);
           recompute(true); renderAll();
           log(r.ok ? `已把 @${u.h} 加入白名单并保存` : `加入 @${u.h} 失败：无法写入本地存储`, r.ok ? 'ok' : 'err');
         } })];
    list.append(el('div', { class: 'exrow' },
      el('div', { class: 'who' }, avatar(u), el('div', {},
        HANDLE_RE.test(u.h) ? el('a', { href: `https://x.com/${u.h}`, target: '_blank', rel: 'noopener noreferrer', text: u.n || u.h }) : el('span', { text: u.n || u.h }),
        el('span', { class: 'h', text: `@${u.h} · ${reasonText(why)}` }))),
      el('div', { class: 'acts' }, acts)));
  }
  if (rows.length > 300) list.append(el('div', { class: 'empty', text: '只显示前 300 个，请用搜索缩小范围。' }));
}

async function removeFromWl(u) {
  // 先拿 storage/备份里最新的一份，避免用过期列表把别处刚加的人一并覆盖
  const o = await chrome.storage.local.get(['xfh_whitelist', WL_REV_KEY]);
  const pick = newerWl(o.xfh_whitelist, o[WL_REV_KEY]);
  if (pick.rev > 0) { S.whitelist = pick.list; S.wlRev = pick.rev; }
  S.whitelist = S.whitelist.filter((w) => !((w.id && w.id === u.id) || String(w.h || '').toLowerCase() === String(u.h || '').toLowerCase()));
  rebuildWl();
  const ok = await saveWl();
  recompute(true); renderAll();
  log(ok ? `已把 @${u.h} 移出白名单并保存` : `移出 @${u.h} 失败：无法写入本地存储`, ok ? 'ok' : 'err');
}

function forceUnfollow(u) {
  S.forced.add(u.id);
  recompute(true); selected.add(u.id); renderAll();
  log(`已把 @${u.h} 加入取关名单（已勾选）`, 'ok');
}

function renderRows() {
  const tb = $('#rows');
  tb.replaceChildren();
  const q = $('#q').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const u of cand.list) {
    if (q && !(u.h.toLowerCase().includes(q) || String(u.n || '').toLowerCase().includes(q))) continue;
    shown++;
    const cb = el('input', { type: 'checkbox', 'aria-label': '选择 @' + u.h });
    cb.checked = selected.has(u.id);
    cb.addEventListener('change', () => { cb.checked ? selected.add(u.id) : selected.delete(u.id); renderSel(); });
    frag.append(el('tr', {},
      el('td', { class: 'c' }, cb),
      el('td', {}, el('div', { class: 'who' }, avatar(u), el('div', {},
        HANDLE_RE.test(u.h)
          ? el('a', { href: `https://x.com/${u.h}`, target: '_blank', rel: 'noopener noreferrer', text: u.n || u.h })
          : el('span', { text: u.n || u.h }),
        el('span', { class: 'h', text: '@' + u.h })))),
      el('td', { class: 'n', text: fmtNum(u.fo) }),
      el('td', { class: 'n', text: fmtNum(u.fi) }),
      el('td', { class: 'n', text: fmtNum(u.t) }),
      el('td', {}, badges(u))));
  }
  tb.append(frag);
  const head = $('#colAccount');
  if (head) {
    const n = cand.list.length;
    if (S.scan && mode === 'unfollow') head.textContent = q && shown !== n ? `账号（${shown} / ${n} 个）` : `账号（${n} 个）`;
    else head.textContent = '账号';
  }
  const empty = $('#empty');
  if (!S.scan) empty.textContent = '点“扫描关注列表”开始。';
  else if (q && !shown) empty.textContent = explainMiss(q);
  else if (!cand.list.length) empty.textContent = mode === 'unfollow' ? '没有需要取关的账号。' : '没有需要回关的账号。';
  else empty.textContent = '';
  empty.hidden = !empty.textContent;
}

function renderNote() {
  const s = cand.skipped || {};
  const parts = [];
  if (mode === 'unfollow') {
    if (s.wl) parts.push(`白名单 ${s.wl} 个`);
    if (s.verified) parts.push(`认证账号 ${s.verified} 个`);
    if (s.big) parts.push(`粉丝数达标的大号 ${s.big} 个`);
    if (s.grace) parts.push(`宽限期内 ${s.grace} 个`);
    if (s.incomplete) parts.push(`资料未补全 ${s.incomplete} 个`);
    $('#filterNote').textContent = parts.length ? `已自动排除：${parts.join('，')}（可在下方“已排除的账号”里逐个处理）。` : '';
  } else {
    if (s.stale) { $('#filterNote').textContent = '扫描数据里没有“付费蓝 V”标记：可能是旧数据，也可能是当前接口不返回。请先重新扫描；仍然如此就在“设置 → 检查接口”里看哪个接口带标记。'; return; }
    if (s.unverified) parts.push(`非付费蓝 V ${s.unverified} 个`);
    if (s.bot) parts.push(`疑似营销号 ${s.bot} 个`);
    if (s.incomplete) parts.push(`资料未补全 ${s.incomplete} 个`);
    $('#filterNote').textContent = parts.length ? `已自动过滤：${parts.join('，')}。` : '';
  }
}

function renderSel() {
  const n = selected.size;
  let blue = 0;
  if (n) for (const u of cand.list) if (selected.has(u.id) && u.b === true) blue++;
  $('#selInfo').textContent = S.scan ? `已勾选 ${n} / ${cand.list.length} 个` : '未选择账号';
  const verb = mode === 'unfollow' ? '取关' : '回关';
  $('#btnStart').textContent = `${S.settings.dryRun ? '试运行：' : '开始'}${verb}${n ? `（${n}，蓝 V ${blue}）` : ''}`;
  updateUI();
}

function renderProgress() {
  const q = S.queue;
  const pct = q && q.total ? Math.round((q.done / q.total) * 100) : 0;
  $('#barFill').style.width = pct + '%';
  if (q && (S.running || q.items.length)) {
    setStatus(`${q.op === 'unfollow' ? '取关' : '回关'}进度 ${q.done} / ${q.total}（成功 ${q.ok}，跳过 ${q.skip}，失败 ${q.fail}）`);
  }
}

function renderDaily() {
  const d = S.daily && S.daily.date === today()
    ? { unfollow: Number(S.daily.unfollow) || 0, follow: Number(S.daily.follow) || 0 }
    : { unfollow: 0, follow: 0 };
  const s = S.settings;
  const cap = (n) => (n > 0 ? n : '不限');
  $('#daily').textContent = `今日已取关 ${d.unfollow} / ${cap(s.dailyUnfollow)}，已回关 ${d.follow} / ${cap(s.dailyFollow)}`;
}

function renderBanners() {
  const rb = $('#resume');
  rb.replaceChildren();
  const q = S.queue;
  if (q && q.items.length && !S.running) {
    rb.hidden = false;
    rb.append(
      el('div', { text: `有一个未完成的${q.op === 'unfollow' ? '取关' : '回关'}任务，还剩 ${q.items.length} 个。` }),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary sm', text: '继续任务', onclick: () => { askNotifyPermission(); resumeQueue(); } }),
        el('button', { class: 'btn quiet sm', text: '放弃', onclick: discardQueue })));
  } else rb.hidden = true;

  const cd = $('#cooldown');
  if (S.cooldown && S.cooldown.until > Date.now()) {
    const t = new Date(S.cooldown.until).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
    cd.hidden = false;
    cd.textContent = `${S.cooldown.why}。建议 ${t} 之后再运行。`;
  } else cd.hidden = true;
}

function updateUI() {
  const busy = S.running || S.scanning || S.autoBusy;
  $('#btnScan').disabled = busy;
  $('#btnStop').hidden = !busy;
  $('#btnStart').hidden = busy;
  $('#btnStart').disabled = busy || selected.size === 0;
  $('#quickVerified').hidden = mode !== 'followback';
  $('#cbVerifiedOnly').checked = !!S.settings.followbackVerifiedOnly;
  $('#cbVerifiedOnly').disabled = busy;
  $('#btnWl').hidden = mode !== 'unfollow';
  $('#btnWl').disabled = busy || selected.size === 0;
  $$('#modes button').forEach((b) => { b.disabled = busy; });
}

function renderAll() {
  renderStats(); renderRows(); renderNote(); renderSel(); renderDaily(); renderBanners(); renderProgress(); renderWl(); renderAuto(); renderExcluded();
  if ($('#tab-history').classList.contains('on')) renderHistory();
}

/* ================= 历史 ================= */

async function addHistory(rec) {
  S.history.push(rec);
  if (S.history.length > 5000) S.history.splice(0, S.history.length - 5000);
  await store.set('xfh_history', S.history);
}

function renderHistory() {
  const tb = $('#hRows');
  tb.replaceChildren();
  const rows = S.history.slice(-300).reverse();
  $('#hEmpty').hidden = rows.length > 0;
  for (const r of rows) {
    const key = r.t + '-' + r.id;
    const canRefollow = r.op === 'unfollow' && r.ok && !r.dry;
    const cb = canRefollow ? el('input', { type: 'checkbox', 'aria-label': '选择 @' + r.h }) : null;
    if (cb) { cb.checked = hSel.has(key); cb.addEventListener('change', () => { cb.checked ? hSel.add(key) : hSel.delete(key); }); }
    tb.append(el('tr', {},
      el('td', { class: 'c' }, cb),
      el('td', { text: fmtTime(r.t) }),
      el('td', { text: (r.op === 'unfollow' ? '取关' : '回关') + (r.auto ? '（自动）' : '') + (r.dry ? '（试运行）' : '') }),
      el('td', {}, HANDLE_RE.test(r.h) ? el('a', { href: `https://x.com/${r.h}`, target: '_blank', rel: 'noopener noreferrer', text: '@' + r.h }) : el('span', { text: '@' + r.h })),
      el('td', { text: r.ok ? '成功' : (r.err || '失败') })));
  }
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;      // 防 CSV 公式注入
  return '"' + s.replace(/"/g, '""') + '"';
}

/* ================= 任务队列 ================= */

async function getDaily() {
  if (!S.daily || S.daily.date !== today()) S.daily = { date: today(), unfollow: 0, follow: 0 };
  S.daily.unfollow = Number(S.daily.unfollow) || 0;
  S.daily.follow = Number(S.daily.follow) || 0;
  return S.daily;
}

async function reloadLive() {
  const o = await chrome.storage.local.get(['xfh_settings', 'xfh_whitelist', 'xfh_whitelist_rev']);
  S.settings = { ...DEFAULTS, ...(o.xfh_settings && typeof o.xfh_settings === 'object' ? o.xfh_settings : {}) };
  const wl = newerWl(o.xfh_whitelist, o.xfh_whitelist_rev);
  S.whitelist = wl.list;
  S.wlRev = wl.rev;
  rebuildWl();
}

const saveQueue = () => store.set('xfh_queue', S.queue);

function setCooldown(ms, why, scope = 'manual') {
  S.cooldown = { until: Date.now() + ms, why, scope };
  store.set('xfh_cooldown', S.cooldown);
  renderBanners();
}

function applyToScan(op, id) {
  if (!S.scan) return;
  if (op === 'unfollow') {
    S.scan.following = S.scan.following.filter((u) => u.id !== id);
    if (Array.isArray(S.scan.followingIds)) S.scan.followingIds = S.scan.followingIds.filter((x) => x !== id);
    delete S.firstSeen[id];
  } else {
    const u = S.scanMap.get(id);
    if (u && !S.scan.following.some((x) => x.id === id)) S.scan.following.push(u);
    if (Array.isArray(S.scan.followingIds) && !S.scan.followingIds.includes(id)) S.scan.followingIds.push(id);
    S.firstSeen[id] = Date.now();
  }
  S.scanDirty = true;
}

async function persistScan() {
  if (!S.scanDirty || !S.scan) return;
  S.scanDirty = false;
  await Promise.all([store.set('xfh_scan', S.scan), store.set('xfh_firstSeen', S.firstSeen)]);
}

function notifyDone(title, body) {
  const away = document.hidden || !document.hasFocus();
  if (!away) return;                       // 人就在页面上，看日志就行
  document.title = `${title} · X 互关助手`;
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'xfh-done' }); } catch (_) { /* 通知失败不影响任务 */ }
  }
}

function askNotifyPermission() {           // 必须在点击事件里调用才会弹出授权
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (_) { /* ignore */ }
  }
}

function describeFatal(r) {
  const t = errText(r);
  if (r.kind === 'rate') return `触发了 X 的频率限制：${t}。已自动停止，建议至少等 30 分钟再继续。`;
  if (r.kind === 'locked') return `X 提示账号受限或疑似自动化行为：${t}。已自动停止，请先到 X 上完成验证，24 小时内不要再运行。`;
  if (r.kind === 'auth') return `登录状态或 CSRF 校验失败：${t}。请刷新 x.com 标签页并确认已登录。`;
  return r.message || t;
}

function estimate(op, n) {
  const s = S.settings;
  const [a, b] = op === 'unfollow' ? [s.unfollowMin, s.unfollowMax] : [s.followMin, s.followMax];
  const sec = n * (a + b) / 2 + Math.floor(n / Math.max(1, s.batchSize)) * s.batchRest;
  const m = Math.round(sec / 60);
  return m < 90 ? `${Math.max(1, m)} 分钟` : `${(m / 60).toFixed(1)} 小时`;
}

async function startRun(op, items) {
  if (!isPrimary) { log('另一个仪表盘正在运行，这个页面只读。', 'warn'); return; }
  if (S.running || S.scanning || S.autoBusy) { log('已有任务在运行，请等它结束。', 'warn'); return; }
  if (!items.length) return;
  if (S.scan && S.scan.warn && !confirm(`上次扫描的结果可能不完整（${S.scan.warn}），名单可能不准。建议先重新扫描。\n仍要继续吗？`)) return;
  await reloadLive();
  const un = op === 'unfollow';
  const d = await getDaily();
  const cap = un ? S.settings.dailyUnfollow : S.settings.dailyFollow;
  let msg = `${S.settings.dryRun ? '【试运行，不会真正操作】\n' : ''}将${un ? '取关' : '回关'} ${items.length} 个账号，按当前间隔约需 ${estimate(op, items.length)}。`;
  if (!S.settings.dryRun && cap > 0 && items.length > cap - d[op]) {
    msg += `\n今天的${un ? '取关' : '回关'}上限还剩 ${Math.max(0, cap - d[op])} 个，用完后任务会暂停，之后可以继续。`;
  }
  msg += '\n\n任务运行期间请保持这个页面和 x.com 标签页都开着。确认开始吗？';
  if (!confirm(msg)) return;
  if (S.cooldown && S.cooldown.until > Date.now() && !confirm(`${S.cooldown.why}，建议先暂停。仍要现在开始吗？`)) return;
  if (S.queue && S.queue.items.length && !confirm('还有一个未完成的任务，开始新任务会覆盖它。继续吗？')) return;

  S.queue = { op, total: items.length, items: items.map((u) => ({ id: u.id, h: u.h, force: S.forced.has(u.id) })), done: 0, ok: 0, skip: 0, fail: 0, startedAt: Date.now() };
  await saveQueue();
  await runQueue();
}

async function resumeQueue() {
  if (!S.queue || !S.queue.items.length || S.running) return;
  if (S.cooldown && S.cooldown.until > Date.now() && !confirm(`${S.cooldown.why}，建议先暂停。仍要继续吗？`)) return;
  await runQueue();
}

async function discardQueue() {
  if (!confirm('放弃这个任务？已经完成的操作不会撤销。')) return;
  S.queue = null; await store.remove('xfh_queue'); renderBanners(); renderProgress(); setStatus('空闲');
}

async function runQueue() {
  const q = S.queue;
  if (!q || !q.items.length) return;
  const op = q.op, un = op === 'unfollow';
  const verb = un ? '取关' : '回关';

  const p = await checkConn();
  if (!p) { log('无法连接 x.com 标签页：' + $('#acct').textContent, 'err'); return; }

  S.running = true; S.stop = false; updateUI(); renderBanners();
  log(`开始${verb}：共 ${q.items.length} 个${S.settings.dryRun ? '（试运行）' : ''}`);
  let inBatch = 0, streak = 0, reason = '';

  try {
    while (q.items.length && !S.stop) {
      await reloadLive();
      const s = q.auto ? autoSettings() : S.settings;       // 自动模式用更保守的固定节奏
      const daily = await getDaily();
      const cap = un ? s.dailyUnfollow : s.dailyFollow;
      if (!s.dryRun && cap > 0 && daily[op] >= cap) { reason = `已达到今日${verb}上限（${cap}），明天可以继续。`; break; }
      if (q.auto && !s.dryRun && hourlyUsed() >= s.hourly) { reason = `已达到本小时上限（${s.hourly}）。`; break; }
      if (q.auto && q.deadline && Date.now() >= q.deadline) { reason = '已达到本时段的结束时间。'; break; }

      const it = q.items[0];

      // 执行前再校验一次白名单：队列可能是旧的，名单可能刚改过
      if (un) {
        const why = protectedReason(S.scanMap.get(it.id) || it);
        if (why && (why === 'wl' || !it.force)) {         // 你手动点了“仍然取关”的可以放行，白名单永远不放行
          log(`跳过 @${it.h}：${reasonText(why)}`, 'dim');
          q.items.shift(); q.done++; q.skip++;
          await saveQueue(); renderProgress();
          continue;
        }
      }

      let res;
      if (s.dryRun) res = { ok: true, dry: true };
      else {
        for (let attempt = 0; ; attempt++) {
          try { res = await call({ op, id: it.id }); } catch (e) { res = { ok: false, kind: 'conn', message: connMsg(e) }; }
          if (res.ok || ['rate', 'locked', 'auth', 'skip', 'conn'].includes(res.kind)) break;
          if (attempt >= s.maxRetries) break;
          log(`@${it.h} 失败：${errText(res)}，第 ${attempt + 1}/${s.maxRetries} 次重试`, 'warn');
          await waitSec(8 * (attempt + 1), '重试等待');
          if (S.stop) break;
        }
        if (S.stop && !res.ok) break;               // 在重试等待中被停止：这个账号留在队列里
      }

      if (res.ok) {
        q.ok++; streak = 0;
        if (!res.dry) { daily[op]++; await store.set('xfh_daily', daily); applyToScan(op, it.id); }
        await addHistory({ t: Date.now(), op, id: it.id, h: it.h, auto: !!q.auto, ok: true, dry: !!res.dry });
        log(`${res.dry ? '（试运行）' : ''}✓ 已${verb} @${it.h}`, 'ok');
      } else if (res.kind === 'skip') {
        q.skip++; streak = 0;
        await addHistory({ t: Date.now(), op, id: it.id, h: it.h, auto: !!q.auto, ok: false, err: '跳过：' + (res.message || '') });
        log(`跳过 @${it.h}：${errText(res)}`, 'dim');
      } else if (['rate', 'locked', 'auth', 'conn'].includes(res.kind)) {
        reason = describeFatal(res);
        const scope = q.auto ? 'auto' : 'manual';
        if (res.kind === 'rate') { setCooldown(30 * 60e3, '刚触发过 X 的频率限制', scope); recordRateLimit(); }
        if (res.kind === 'locked') {
          setCooldown(24 * 3600e3, 'X 提示账号受限或疑似自动化', scope);
          holdAutoForManual('X 提示账号受限或疑似自动化行为，需要你手动确认后才会恢复。');
        }
        if (res.kind === 'auth' && q.auto) {
          // 登录失效时不要每 30 分钟空转；停下来等人重新登录并确认
          setCooldown(15 * 60e3, '登录状态或 CSRF 失效', 'auto');
          holdAutoForManual('登录状态或 CSRF 失效，需要你刷新并重新登录 x.com，然后手动确认恢复。');
        }
        break;                                        // 不移出队列，恢复后从这个账号继续
      } else {
        q.fail++; streak++;
        await addHistory({ t: Date.now(), op, id: it.id, h: it.h, auto: !!q.auto, ok: false, err: errText(res) });
        log(`✗ @${it.h}：${errText(res)}`, 'err');
        if (streak >= 5) { reason = '连续 5 个账号失败，已自动停止。请先用“设置 → 检查接口”排查。'; break; }
      }

      q.items.shift(); q.done++;
      await saveQueue(); renderProgress(); renderDaily();
      if (S.scanDirty && q.done % 10 === 0) await persistScan();

      if (!q.items.length || S.stop) break;
      inBatch++;
      if (!q.auto && inBatch >= s.batchSize) {
        inBatch = 0;
        if (!s.dryRun) log(`这一批做完了，休息 ${s.batchRest} 秒`, 'dim');
        await waitSec(s.dryRun ? 1 : s.batchRest, '批次休息');
      } else {
        const [lo, hi] = un ? [s.unfollowMin, s.unfollowMax] : [s.followMin, s.followMax];
        const gap = s.dryRun ? 0.5 : (q.auto ? humanGap() : rand(lo, hi));       // 自动模式：长尾间隔，不分批
        if (q.auto && q.deadline && Date.now() + gap * 1000 > q.deadline) { reason = '已达到本时段的结束时间。'; break; }
        await waitSec(gap, '等待下一个');
      }
    }
  } catch (e) {
    reason = '任务异常中断：' + (e && e.message ? e.message : e);
  } finally {
    S.running = false;
    await persistScan();
  }

  if (!q.items.length) {
    log(`完成！已${verb} ${q.ok}，跳过 ${q.skip}，失败 ${q.fail}`, 'ok');
    S.queue = null; await store.remove('xfh_queue');
    setStatus('任务完成');
    if (!q.auto) notifyDone(`${verb}完成`, `成功 ${q.ok}，跳过 ${q.skip}，失败 ${q.fail}`);
  } else {
    if (reason) {
      const routine = reason.startsWith('已达到');
      log(reason, routine ? 'warn' : 'err');
      if (!(q.auto && routine)) notifyDone(`${verb}已暂停`, `${reason.slice(0, 80)}（还剩 ${q.items.length} 个）`);
    }
    else log(`已停止。已${verb} ${q.ok}，还剩 ${q.items.length} 个，可以稍后继续。`, 'warn');
    if (q.auto) { S.queue = null; await store.remove('xfh_queue'); }   // 自动任务下一轮会重新计算，不留“未完成任务”
    else await saveQueue();
  }
  computeStats(); recompute(true); renderAll();
}

/* ================= 全自动（只自动回关） ================= */

// 自动模式的硬限制：不受设置页里更激进的数字影响，只会更保守。（测试时可以覆盖）
const AUTO = {
  MIN_INTERVAL: 120,         // 回关间隔下限（秒）
  MAX_DAILY: 50,             // 每天回关上限
  MAX_HOURLY: 5,             // 每小时回关上限
  RATE_PAUSE: 6 * 3600e3,    // 第一次触发限流后至少暂停 6 小时
  GAP: [2, 4],               // 两次 ID 请求之间的间隔（秒）
  LOOKUP_GAP: [1, 2],        // 两批资料查询之间的间隔（秒）
  SCALE: 1,                  // 回关间隔倍率（仅测试用）
  REST_P: 0.15,              // 一天整天休息的概率（不会连续两天）
  LIGHT_P: 0.12,             // “很轻的一天”（1–3 个）的概率
  SKIP_P: 0.25,              // 每轮随机放过一部分符合条件的账号（以后仍可能被选中）
  LONG_GAP_P: 0.12,          // 间隔里偶尔夹一次十几分钟的长停顿
};
const DAY_MS = 864e5;

const saveAuto = () => store.set('xfh_auto', S.auto);
const hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const capFactor = () => (S.auto.capHalfDate === today() ? 0.5 : 1);

function autoSettings() {
  const s = { ...S.settings };
  s.followMin = Math.max(AUTO.MIN_INTERVAL, s.followMin);
  s.followMax = Math.max(s.followMin, s.followMax);
  s.batchRest = Math.max(AUTO.MIN_INTERVAL, s.batchRest);
  s.batchSize = Math.min(5, s.batchSize);
  const daily = Math.min(s.autoDaily, AUTO.MAX_DAILY, s.dailyFollow > 0 ? s.dailyFollow : AUTO.MAX_DAILY);
  s.dailyFollow = Math.max(1, Math.floor(daily * capFactor()));
  s.hourly = Math.max(1, Math.min(s.autoHourly, AUTO.MAX_HOURLY));
  return s;
}

const hourlyUsed = () => S.history.filter((r) => r.auto && r.op === 'follow' && r.ok && !r.dry && Date.now() - r.t < 3600e3).length;

const randInt = (a, b) => Math.floor(rand(a, b + 1));
const dayStart = (ts = Date.now()) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const msToTomorrow = () => dayStart() + DAY_MS + rand(5, 40) * 60e3 - Date.now();   // 次日 0:05–0:40 再来生成新一天的计划

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 两次回关之间的间隔：长尾分布（中位数约 3.5 分钟），偶尔隔十几分钟到半小时；绝不低于下限
function humanGap() {
  let g = AUTO.MIN_INTERVAL + Math.exp(Math.log(90) + 0.8 * gauss());
  if (Math.random() < AUTO.LONG_GAP_P) g += rand(600, 1500);
  return Math.min(g, 1800) * AUTO.SCALE;
}

// 只统计自动模式的回关记录；试运行和真实运行分开统计
function countAuto(pred) {
  const dry = !!S.settings.dryRun;
  return S.history.filter((r) => r.auto && r.op === 'follow' && r.ok && !!r.dry === dry && pred(r)).length;
}
const autoDoneToday = () => countAuto((r) => new Date(r.t).toLocaleDateString('sv') === today());
const sessionUsed = (x) => countAuto((r) => r.t >= x.s && r.t < x.e);

// 在 [fromMin, endMin) 里随机放 n 个时段（40–100 分钟），彼此至少隔 45 分钟
function placeSessions(fromMin, endMin, n) {
  const out = [];
  for (let i = 0; i < 60 && out.length < n; i++) {
    const len = randInt(40, 100);
    if (endMin - fromMin < len) break;
    const s = randInt(fromMin, endMin - len), e = s + len;
    if (out.every((x) => e + 45 <= x.s || s >= x.e + 45)) out.push({ s, e });
  }
  return out.sort((a, b) => a.s - b.s);
}

// 每天一份计划：可能休息；数量在最少/最多之间随机且偏少；分成 1–3 个时段，开始结束时间每天有浮动
function makePlan() {
  const s = S.settings, A = S.auto, d = today();
  const plan = { date: d, rest: false, target: 0, sessions: [] };
  const yesterday = new Date(dayStart() - 3600e3).toLocaleDateString('sv');
  if (A.lastRestDate !== yesterday && Math.random() < AUTO.REST_P) { plan.rest = true; A.lastRestDate = d; return plan; }

  const max = Math.max(1, Math.min(s.autoDaily, AUTO.MAX_DAILY));
  const min = Math.max(0, Math.min(s.autoDailyMin, max));
  let target = Math.random() < AUTO.LIGHT_P
    ? randInt(1, Math.min(3, max))                                     // 很轻的一天
    : Math.round(min + (max - min) * Math.pow(Math.random(), 1.6));    // 偏向较少的天数
  target = Math.max(1, Math.floor(target * capFactor()));

  const nowMin = Math.floor((Date.now() - dayStart()) / 60e3);
  const a = clamp(s.autoStartHour * 60 + randInt(-30, 30), 0, 1439);
  const b = clamp(s.autoEndHour * 60 + randInt(-30, 30), a + 1, 1440);
  const nSess = Math.min(target, target <= 3 ? 1 : (Math.random() < 0.5 ? 2 : 3));
  const mins = placeSessions(Math.max(a, nowMin), b, nSess);
  if (!mins.length) return plan;                                       // 今天剩余时间太短，明天再开始

  const w = mins.map(() => 0.5 + Math.random());
  const sum = w.reduce((x, y) => x + y, 0);
  let left = target;
  plan.sessions = mins.map((m, i) => {
    const q = i === mins.length - 1 ? left : Math.min(left, Math.max(1, Math.round(target * w[i] / sum)));
    left -= q;
    return { s: dayStart() + m.s * 60e3, e: dayStart() + m.e * 60e3, quota: Math.max(0, q) };
  }).filter((x) => x.quota > 0);
  // 过滤掉 quota=0 的时段后，target 要和实际配额一致，否则当天永远做不满
  plan.target = plan.sessions.reduce((n, x) => n + x.quota, 0);
  return plan;
}

function planSummary(plan) {
  if (plan.rest) return '今天安排休息，不会自动回关。';
  if (!plan.sessions.length) return '今天剩余时间太短，明天再开始。';
  return `今天计划回关 ${plan.target} 个，分 ${plan.sessions.length} 个时段：` +
    plan.sessions.map((x) => `${hhmm(x.s)}–${hhmm(x.e)}（${x.quota} 个）`).join('、') + '。';
}

function ensurePlan() {
  const A = S.auto;
  if (A.plan && A.plan.date === today()) return A.plan;
  A.plan = makePlan();
  saveAuto();
  log('[自动] ' + planSummary(A.plan), 'dim');
  return A.plan;
}

// 下一次该醒来的时间：时段内还有配额就隔 15–30 分钟再看；否则等下一个时段；今天没有了就等明天
function msToNextSlot(plan, now = Date.now()) {
  if (plan && !plan.rest && autoDoneToday() < plan.target) {
    const cur = plan.sessions.find((x) => now >= x.s && now < x.e);
    if (cur && sessionUsed(cur) < cur.quota && cur.e - now > 3 * 60e3) {
      return Math.max(15000, Math.min(rand(15, 30) * 60e3, cur.e - now - 60e3));
    }
    const next = plan.sessions.find((x) => x.s > now);
    if (next) return next.s - now + rand(0, 120e3);
  }
  return msToTomorrow();
}

function scheduleNext(ms) {
  S.auto.nextRun = Date.now() + ms;
  saveAuto(); renderAuto();
}

// 触发限流：第一次暂停 6 小时；24 小时内第二次暂停到次日，并且次日上限减半
function recordRateLimit() {
  const A = S.auto, now = Date.now();
  A.strikes = (A.strikes || []).filter((t) => now - t < DAY_MS);
  A.strikes.push(now);
  let until = now + AUTO.RATE_PAUSE;
  if (A.strikes.length >= 2) {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    until = Math.max(until, midnight.getTime());
    A.capHalfDate = midnight.toLocaleDateString('sv');
  }
  A.pausedUntil = Math.max(A.pausedUntil || 0, until);
  saveAuto(); renderAuto();
}

function holdAutoForManual(reason) {
  S.auto.needsManual = true;
  S.auto.stopReason = reason;
  saveAuto(); renderAuto();
}

function noteConnProblem() {
  if (Date.now() - (S.lastConnNote || 0) < 3 * 3600e3) return;
  S.lastConnNote = Date.now();
  notifyDone('自动回关：连接不上 X', '请打开并登录 x.com 标签页');
}

function renderAuto() {
  const A = S.auto, now = Date.now();
  $('#cbAuto').checked = !!A.enabled;
  let text;
  if (!A.enabled) text = '手动模式：所有操作都由你点击开始。';
  else if (A.needsManual) text = '已暂停：' + A.stopReason;
  else if (S.autoBusy || (S.running && S.queue && S.queue.auto)) text = '正在运行本轮……';
  else if (A.pausedUntil > now) text = `冷却中，暂停到 ${hhmm(A.pausedUntil)}。`;
  else text = `全自动已开启，下次检查约 ${hhmm(A.nextRun || now)}。`;
  $('#autoStatus').textContent = text;
  $('#autoStatus').classList.toggle('warnt', !!(A.enabled && (A.needsManual || A.pausedUntil > now)));
  const info = [];
  if (A.enabled && A.plan && A.plan.date === today()) info.push(planSummary(A.plan));
  if (A.enabled && A.lastCycle) info.push(`上一轮（${hhmm(A.lastCycle.t)}）：回关 ${A.lastCycle.followed} 个，符合条件 ${A.lastCycle.eligible} 个。`);
  if (A.unfollowable != null) info.push(`目前有 ${A.unfollowable} 个关注的人没有回关你，取关需要你手动执行。`);
  if (A.enabled && capFactor() < 1) info.push('今天因为触发过限流，每日上限已减半。');
  $('#autoInfo').textContent = info.join(' ');
  const busy = S.running || S.scanning || S.autoBusy;
  const blocked = A.needsManual || A.pausedUntil > now;
  $('#autoBtns').hidden = !A.enabled;
  $('#btnAutoNow').hidden = blocked;
  $('#btnAutoNow').disabled = busy;
  $('#btnAutoResume').hidden = !blocked;
  $('#btnAutoResume').textContent = A.needsManual ? '检查后恢复' : '提前恢复';
}

async function resumeAuto() {
  const A = S.auto;
  const msg = A.needsManual
    ? `${A.stopReason}\n\n恢复后会把当前的关注列表当作新的基准重新开始，并取消冷却。你已经检查过账号状态了吗？`
    : `这会提前结束冷却（原定 ${hhmm(A.pausedUntil)}）。X 刚限制过你，提前恢复可能再次触发限制。仍要恢复吗？`;
  if (!confirm(msg)) return;
  if (A.needsManual) { A.needsManual = false; A.stopReason = ''; A.knownFollowing = null; }
  A.pausedUntil = 0;
  // 只清自动模式自己设的冷却，别把手动任务刚触发的冷却也清掉
  if (S.cooldown && S.cooldown.scope === 'auto') {
    S.cooldown = null;
    await store.remove('xfh_cooldown');
  }
  scheduleNext(60e3);
  renderBanners();
  log('[自动] 已恢复自动模式', 'ok');
}

function autoFail(r, finish, what = 'ids') {
  const A = S.auto;
  if (r.kind === 'rate') {
    recordRateLimit();
    log(`[自动] 触发了 X 的频率限制，自动暂停到 ${hhmm(A.pausedUntil)}`, 'err');
    notifyDone('自动回关已暂停', `触发频率限制，暂停到 ${hhmm(A.pausedUntil)}`);
    return finish(A.pausedUntil - Date.now() + rand(0, 20 * 60e3));
  }
  if (r.kind === 'locked') {
    holdAutoForManual('X 提示账号受限或疑似自动化行为，需要你手动确认后才会恢复。');
    setCooldown(24 * 3600e3, 'X 提示账号受限或疑似自动化', 'auto');
    log('[自动] ' + describeFatal(r), 'err');
    notifyDone('自动回关已暂停', A.stopReason);
    return finish(24 * 3600e3);
  }
  if (r.kind === 'auth') {
    holdAutoForManual('登录状态或 CSRF 失效，需要你刷新并重新登录 x.com，然后手动确认恢复。');
    setCooldown(15 * 60e3, '登录状态或 CSRF 失效', 'auto');
    log('[自动] ' + describeFatal(r), 'err');
    notifyDone('自动回关已暂停', A.stopReason);
    return finish(24 * 3600e3);
  }
  if (r.kind === 'skip') {
    holdAutoForManual(what === 'lookup'
      ? `按 ID 查资料失败：${errText(r)}。自动模式暂停，请先在“设置 → 检查接口”里确认接口可用。`
      : '读取关注/粉丝 ID 的接口不可用（X 可能已下线旧接口）。自动模式需要这个接口判断谁关注了你，请先用手动扫描，并在“设置 → 检查接口”里确认。');
    log('[自动] ' + errText(r), 'err');
    notifyDone('自动回关已暂停', A.stopReason);
    return finish(6 * 3600e3);
  }
  log(`[自动] 本轮失败：${r.kind === 'conn' ? r.message : errText(r)}，30 分钟后重试`, 'err');
  return finish(30 * 60e3);
}

// 一轮：取 ID → 数据闸门 → 找出待回关 → 查资料筛选 → 在小时/每日上限内回关
async function autoCycle(force = false) {
  if (!isPrimary) return;
  if (S.running || S.scanning || S.autoBusy) return;
  const A = S.auto;
  if (A.needsManual || Date.now() < A.pausedUntil) return;      // 暂停期间任何入口都不会自动开跑
  S.autoBusy = true; updateUI(); renderAuto();
  const finish = (ms) => { S.autoBusy = false; scheduleNext(ms); updateUI(); renderAuto(); };
  const stopped = () => {
    if (!S.stop) return false;
    S.stop = false; log('[自动] 本轮已手动停止', 'warn');
    return true;
  };
  const getIds = (kind) => call({ op: 'ids', kind }, 180000).catch((e) => ({ ok: false, kind: 'conn', message: connMsg(e) }));

  try {
    if (S.queue && S.queue.items.length && !S.queue.auto) {
      log('[自动] 有未完成的手动任务，本轮跳过', 'warn');
      return finish(15 * 60e3);
    }
    S.stop = false;
    await reloadLive();               // 先读最新设置，再生成/检查今天的计划

    // 今天的计划：休息日、已完成、不在任何时段内，都直接什么也不做（不发任何请求）
    const plan = ensurePlan();
    if (!force) {
      if (plan.rest) { log('[自动] 今天休息，不操作', 'dim'); return finish(msToTomorrow()); }
      if (!plan.sessions.length) return finish(msToTomorrow());
      if (autoDoneToday() >= plan.target) { log(`[自动] 今天的计划（${plan.target} 个）已完成`, 'dim'); return finish(msToTomorrow()); }
      const t0 = Date.now();
      if (!plan.sessions.some((x) => t0 >= x.s && t0 < x.e)) return finish(msToNextSlot(plan));
    }
    log(`[自动] 开始一轮检查……${force ? '（手动触发，忽略时段安排）' : ''}`);
    if (!(await checkConn())) {
      log('[自动] 连接不上 x.com 标签页，10 分钟后重试', 'warn');
      noteConnProblem();
      return finish(10 * 60e3);
    }

    // 1. 只取 ID（每个列表一次请求）
    const fi = await getIds('following');
    if (!fi.ok) return autoFail(fi, finish, 'ids');
    await waitSec(rand(...AUTO.GAP));
    if (stopped()) return finish(msToNextSlot(plan));
    const fo = await getIds('followers');
    if (!fo.ok) return autoFail(fo, finish, 'ids');
    if (!fi.ids.length && !fo.ids.length) { log('[自动] 两个 ID 列表都是空的，数据异常，本轮跳过', 'err'); return finish(30 * 60e3); }
    const nowFollowing = new Set(fi.ids), nowFollowers = new Set(fo.ids);

    // 2. 数据闸门：关注列表比上次少太多，说明数据可能被截断，整轮不动手
    let known = A.knownFollowing;
    if (known === undefined) known = S.scan ? S.scan.following.map((u) => u.id) : [];
    const unfollowedByUs = new Set(S.history.filter((r) => r.op === 'unfollow' && r.ok && !r.dry).map((r) => r.id));
    A.ignored = A.ignored || {};
    for (const id of unfollowedByUs) A.ignored[id] = A.ignored[id] || Date.now();
    if (known !== null) {
      const missing = known.filter((id) => !nowFollowing.has(id) && !unfollowedByUs.has(id));
      if (known.length >= 20 && missing.length > Math.max(5, known.length * 0.1)) {
        holdAutoForManual(`关注列表比上次少了 ${missing.length} 个（上次共 ${known.length} 个），数据可能异常，已暂停所有自动操作。`);
        log('[自动] ' + A.stopReason, 'err');
        notifyDone('自动回关已暂停', A.stopReason);
        return finish(24 * 3600e3);
      }
      // 以前关注过、现在不在关注列表里的（你自己取关的）：以后不再自动回关
      for (const id of missing) A.ignored[id] = Date.now();
    }
    A.knownFollowing = fi.ids;
    A.unfollowable = fi.ids.filter((id) => !nowFollowers.has(id)).length;

    // 3. 待回关 = 关注了我、我没关注、没被忽略、近期没试过
    const now = Date.now();
    const tried = new Set();
    for (const r of S.history) {
      if (r.op !== 'follow' || r.dry) continue;
      const win = (r.ok || /^跳过/.test(r.err || '')) ? 7 * DAY_MS : DAY_MS;
      if (now - r.t < win) tried.add(r.id);
    }
    const raw = fo.ids.filter((id) => !nowFollowing.has(id) && !A.ignored[id] && !tried.has(id));

    // 4. 只为还没有资料（或资料超过 7 天）的人查资料
    A.cache = A.cache || {};
    const need = raw.filter((id) => !A.cache[id] || now - A.cache[id].at > 7 * DAY_MS);
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const lr = await call({ op: 'lookup', ids: chunk }).catch((e) => ({ ok: false, kind: 'conn', message: connMsg(e) }));
      if (!lr.ok) return autoFail(lr, finish, 'lookup');
      const got = new Set();
      for (const u of lr.users || []) { A.cache[u.id] = { ...u, at: now }; got.add(u.id); }
      // 只把接口明确说查不到的记成 gone。没返回又不在 gone 里的，下次再查，避免一次解析失败就把人排除 7 天。
      for (const id of lr.gone || []) if (!got.has(id)) A.cache[id] = { gone: true, at: now };
      if (i + 100 < need.length) await waitSec(rand(...AUTO.LOOKUP_GAP));
      if (stopped()) return finish(msToNextSlot(plan));
    }
    const keys = Object.keys(A.cache);
    if (keys.length > 2000) keys.sort((a, b) => A.cache[a].at - A.cache[b].at).slice(0, keys.length - 2000).forEach((k) => delete A.cache[k]);

    // 5. 按设置里的过滤规则筛选（和手动模式一致）
    const s = autoSettings();
    const eligible = [];
    let skipV = 0, skipBot = 0;
    for (const id of raw) {
      const u = A.cache[id];
      if (!u || u.gone) continue;
      if (s.followbackVerifiedOnly && u.b !== true) { skipV++; continue; }
      if (s.skipBotLike && isBotLike(u)) { skipBot++; continue; }
      eligible.push(u);
    }

    // 6. 小时 / 每日上限
    const daily = await getDaily();
    const remainDay = s.dryRun ? Infinity : s.dailyFollow - daily.follow;
    const remainHour = s.dryRun ? Infinity : s.hourly - hourlyUsed();
    const tNow = Date.now();
    const sess = force ? null : plan.sessions.find((x) => tNow >= x.s && tNow < x.e);
    if (!force && !sess) return finish(msToNextSlot(plan));          // 查资料期间时段结束了
    const planLeft = force ? Infinity : Math.max(0, plan.target - autoDoneToday());
    const sessLeft = force ? Infinity : Math.max(0, sess.quota - sessionUsed(sess));
    // 随机放过一部分：真人不会把每个符合条件的人都机械地关注一遍（被放过的以后仍可能被选中）
    const pool = force ? eligible : eligible.filter(() => Math.random() >= AUTO.SKIP_P);
    const n = Math.max(0, Math.min(pool.length, remainDay, remainHour, planLeft, sessLeft));
    log(`[自动] 粉丝 ${fo.ids.length}、关注 ${fi.ids.length}；待回关 ${raw.length}，符合条件 ${eligible.length}（非付费蓝 V ${skipV}，疑似营销号 ${skipBot}）` +
      (force ? '' : `，本轮随机选 ${pool.length}，本时段还可回关 ${sessLeft}`));
    A.lastCycle = { t: Date.now(), followed: 0, eligible: eligible.length };
    await saveAuto();

    if (n === 0) {
      log(`[自动] 本轮不回关：${eligible.length ? '已达到上限或这一轮随机放过了' : '没有符合条件的账号'}`, 'dim');
      return finish(msToNextSlot(plan));
    }

    // 7. 交给统一的任务队列执行（间隔、重试、限流处理都复用）
    const items = pool.slice(0, n).map((u) => ({ id: u.id, h: u.h }));
    S.queue = { op: 'follow', auto: true, deadline: sess ? sess.e : null, total: items.length, items, done: 0, ok: 0, skip: 0, fail: 0, startedAt: Date.now() };
    await saveQueue();
    const q = S.queue;
    await runQueue();
    if (S.queue && S.queue.auto) { S.queue = null; await store.remove('xfh_queue'); }   // 没跑起来（例如连接断了）也不留“未完成任务”
    A.lastCycle.followed = q.ok;
    await saveAuto();
    if (A.needsManual) return finish(24 * 3600e3);
    if (A.pausedUntil > Date.now()) return finish(A.pausedUntil - Date.now() + rand(0, 20 * 60e3));
    log(`[自动] 本轮结束：回关 ${q.ok} 个`, q.ok ? 'ok' : 'dim');
    return finish(msToNextSlot(plan));
  } catch (e) {
    log('[自动] 本轮异常：' + (e && e.message ? e.message : e), 'err');
    return finish(30 * 60e3);
  }
}

let autoTicks = 0;
async function autoLoop() {
  if (!isPrimary) return;
  for (;;) {
    await tick();
    if (++autoTicks % 20 !== 0) continue;            // 约每 10 秒检查一次
    renderAuto();
    const A = S.auto, now = Date.now();
    if (!A.enabled || A.needsManual || S.running || S.scanning || S.autoBusy) continue;
    if (now < A.pausedUntil || now < A.nextRun) continue;
    autoCycle();
  }
}

/* ================= 设置表单 ================= */

function buildForm() {
  const root = $('#form');
  root.replaceChildren();
  GROUPS.forEach((g, gi) => {
    const sec = el('div', { class: 'fgroup' }, el('h3', { text: g.title }), g.hint ? el('p', { class: 'note', text: g.hint }) : null);
    for (const [key, label, type, min, max] of g.fields) {
      let input;
      if (type === 'bool') {
        input = el('input', { type: 'checkbox' });
        input.addEventListener('change', () => setSetting(key, input.checked));
      } else {
        input = el('input', { type: 'number', min, max, step: 1 });
        input.addEventListener('change', () => setSetting(key, clamp(Math.round(Number(input.value) || 0), min, max)));
      }
      formInputs[key] = input;
      sec.append(el('label', { class: 'frow' }, el('span', { text: label }), input));
    }
    if (gi === 0) sec.append(el('p', { class: 'note warnt', id: 'paceWarn' }));
    root.append(sec);
  });
  syncForm();
}

function syncForm() {
  for (const [k, input] of Object.entries(formInputs)) {
    if (input.type === 'checkbox') input.checked = !!S.settings[k]; else input.value = S.settings[k];
  }
  const s = S.settings;
  $('#paceWarn').textContent = (s.unfollowMin < 15 || s.followMin < 60)
    ? '当前间隔偏短，被 X 限制或封禁的风险会明显升高。' : '';
}

async function setSetting(key, v) {
  S.settings[key] = v;
  const s = S.settings;
  if (s.unfollowMin > s.unfollowMax) [s.unfollowMin, s.unfollowMax] = [s.unfollowMax, s.unfollowMin];
  if (s.followMin > s.followMax) [s.followMin, s.followMax] = [s.followMax, s.followMin];
  if (s.autoStartHour >= s.autoEndHour) s.autoEndHour = Math.min(24, s.autoStartHour + 1);   // 时段不支持跨午夜
  if (s.autoDailyMin > s.autoDaily) s.autoDailyMin = s.autoDaily;
  await store.set('xfh_settings', s);
  syncForm();
  recompute(true);   // 保留用户已勾选的账号；规则变化新放出来的候选不自动勾选
  renderAll();
}

/* ================= 页面与事件 ================= */

function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'history') renderHistory();
  if (name === 'whitelist') renderWl();
}

function setMode(m) {
  mode = m;
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  recompute(false); renderAll();
}

function route() {
  const h = location.hash.slice(1);
  if (h === 'unfollow' || h === 'followback') { showTab('task'); setMode(h); }
  else if (['task', 'whitelist', 'history', 'settings'].includes(h)) showTab(h);
}

function bind() {
  // 多个仪表盘/设置页同时存在时，让白名单变更即时同步过来，避免旧页面覆盖新数据
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.xfh_whitelist && !changes[WL_REV_KEY])) return;
    const rev = Number((changes[WL_REV_KEY] && changes[WL_REV_KEY].newValue) ?? S.wlRev) || 0;
    const next = sanitizeWhitelist(changes.xfh_whitelist ? changes.xfh_whitelist.newValue : S.whitelist);
    try { localStorage.setItem(WL_BACKUP, JSON.stringify({ rev, list: next })); } catch (_) {}
    S.wlRev = Math.max(S.wlRev || 0, rev);
    if (JSON.stringify(next) === JSON.stringify(S.whitelist)) return;
    S.whitelist = next;
    rebuildWl();
    recompute(true);
    renderAll();
  });

  $$('#tabs button').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); }));
  $$('#modes button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); history.replaceState(null, '', '#' + b.dataset.mode); }));
  window.addEventListener('hashchange', route);
  window.addEventListener('focus', () => {
    if (!isPrimary) return;
    document.title = 'X 互关助手';
    if (!S.running && !S.scanning) checkConn();
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.running || (isPrimary && S.auto.enabled)) { e.preventDefault(); e.returnValue = ''; }
  });

  $('#btnScan').addEventListener('click', scan);
  $('#cbAuto').addEventListener('change', async (e) => {
    const A = S.auto;
    if (e.target.checked) {
      if (!confirm('开启全自动模式？\n\n• 只自动回关；取关永远需要你手动点\n• 每天的数量随机、分成几个时段，偶尔整天休息，时段之外不做任何操作\n• 回关间隔长短不一，比手动模式更慢\n• 需要保持这个页面和 x.com 标签页开着，电脑不要睡眠\n• 批量关注违反 X 的自动化规则，仍有被限制的风险\n\n确认开启吗？')) { e.target.checked = false; return; }
      askNotifyPermission();
      A.enabled = true;
      scheduleNext(30e3);
      log('[自动] 已开启，约 30 秒后生成今天的计划（不一定马上回关，要等时段；想先看效果可点“立即检查一轮”）', 'ok');
    } else {
      A.enabled = false;
      if (S.running && S.queue && S.queue.auto) S.stop = true;
      log('[自动] 已关闭，回到手动模式', 'warn');
    }
    await saveAuto(); renderAuto();
  });
  $('#btnAutoNow').addEventListener('click', () => autoCycle(true));
  $('#btnAutoResume').addEventListener('click', resumeAuto);
  $('#cbVerifiedOnly').addEventListener('change', (e) => setSetting('followbackVerifiedOnly', e.target.checked));
  $('#btnStop').addEventListener('click', () => { S.stop = true; setStatus('正在停止……'); });
  $('#btnClearLog').addEventListener('click', () => $('#log').replaceChildren());
  let qTimer = 0;
  $('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { renderRows(); renderExcluded(); }, 120);
  });
  $('#btnAll').addEventListener('click', () => { cand.list.forEach((u) => selected.add(u.id)); renderRows(); renderSel(); });
  $('#btnNone').addEventListener('click', () => { selected.clear(); renderRows(); renderSel(); });
  $('#btnWl').addEventListener('click', async () => {
    const users = cand.list.filter((u) => selected.has(u.id));
    if (!users.length) return;
    const { n, ok } = await addToWl(users);
    log(ok ? `已把 ${n} 个账号加入白名单并保存` : `加入白名单失败：无法写入本地存储（${n} 个）`, ok ? 'ok' : 'err');
    recompute(true); renderAll();
  });
  $('#btnStart').addEventListener('click', () => {
    askNotifyPermission();
    const items = cand.list.filter((u) => selected.has(u.id));
    startRun(mode === 'unfollow' ? 'unfollow' : 'follow', items);
  });

  // 白名单
  $('#wlSearch').addEventListener('input', renderWl);
  $('#wlAdd').addEventListener('click', async () => {
    const handles = parseHandles($('#wlInput').value);
    if (!handles.length) { $('#wlMsg').textContent = '没有识别到有效的用户名。'; return; }
    const byHandle = new Map((S.scan ? S.scan.following : []).map((u) => [u.h.toLowerCase(), u]));
    const users = handles.map((h) => byHandle.get(h.toLowerCase()) || { id: null, h, n: h, a: '' });
    const { n, ok } = await addToWl(users);
    $('#wlInput').value = '';
    $('#wlMsg').textContent = ok
      ? `已保存：新增 ${n} 个，${handles.length - n} 个已在名单里（共 ${S.whitelist.length} 个）。重新打开或扫描后仍会保留。`
      : `新增 ${n} 个，但写入本地存储失败，请重试。`;
    recompute(true); renderAll();
  });
  $('#wlExport').addEventListener('click', () => download('xfh-whitelist.json', JSON.stringify(S.whitelist, null, 2), 'application/json'));
  $('#wlImportBtn').addEventListener('click', () => $('#wlImport').click());
  $('#wlImport').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const arr = JSON.parse(await f.text());
      if (!Array.isArray(arr)) throw new Error('文件内容不是数组');
      const users = arr.map((x) => ({
        id: /^\d+$/.test(String(x.id)) ? String(x.id) : null,
        h: String(x.h || x.handle || '').replace(/^@/, ''),
        n: String(x.n || x.name || x.h || ''),
        a: typeof x.a === 'string' && x.a.startsWith('https://') ? x.a : '',
      })).filter((u) => HANDLE_RE.test(u.h));
      const { n, ok } = await addToWl(users);
      $('#wlMsg').textContent = ok ? `导入完成并已保存：新增 ${n} 个。` : '导入失败：无法写入本地存储。';
      recompute(true); renderAll();
    } catch (err) { $('#wlMsg').textContent = '导入失败：' + err.message; }
  });

  // 历史
  $('#hClear').addEventListener('click', async () => {
    if (!confirm('清空全部操作记录？')) return;
    S.history = []; hSel.clear(); await store.set('xfh_history', []); renderHistory();
  });
  $('#hCsv').addEventListener('click', () => {
    const rows = [['时间', '操作', '用户ID', '用户名', '结果', '备注']];
    for (const r of S.history) rows.push([fmtTime(r.t), r.op === 'unfollow' ? '取关' : '回关', r.id, r.h, r.ok ? '成功' : '失败', (r.dry ? '试运行 ' : '') + (r.err || '')]);
    download('xfh-history.csv', '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  });
  $('#hRefollow').addEventListener('click', () => {
    const items = S.history.filter((r) => hSel.has(r.t + '-' + r.id)).map((r) => ({ id: r.id, h: r.h }));
    if (!items.length) { alert('先在记录里勾选要重新关注的取关记录。'); return; }
    askNotifyPermission();
    hSel.clear();
    showTab('task');
    startRun('follow', items);
  });

  // 设置
  $('#btnDefaults').addEventListener('click', async () => {
    if (!confirm('恢复默认设置？（白名单和记录不受影响）')) return;
    S.settings = { ...DEFAULTS }; await store.set('xfh_settings', S.settings); syncForm(); recompute(true); renderAll();
  });
  $('#btnResetOps').addEventListener('click', async () => {
    try { const r = await call({ op: 'resetOps' }); log(r.ok ? '接口缓存已清除，下次扫描会重新发现。' : '清除失败', r.ok ? 'ok' : 'err'); }
    catch (e) { log(connMsg(e), 'err'); }
    showTab('task');
  });
  $('#btnDiag').addEventListener('click', async () => {
    showTab('task'); log('检查接口……');
    try {
      const r = await call({ op: 'diag' }, 180000);
      if (!r.ok) { log('检查失败：' + errText(r), 'err'); return; }
      for (const [k, v] of Object.entries(r.ops)) log(`${k}：queryId ${v.id}（${v.style === 'relay' ? '新版' : '旧版'}），features ${v.features} 项`, 'ok');
      log(`Bearer：${r.bearerFromPage ? '取自页面脚本' : '使用内置默认值'}；登录用户 ID：${r.me || '未读到'}；CSRF：${r.csrf ? '有' : '无'}`);
      log('逐个测试列表接口（每个只取少量数据）……');
      const pr = await call({ op: 'probe' }, 180000);
      if (!pr.ok) { log('测试失败：' + errText(pr), 'err'); return; }
      for (const x of pr.results) {
        if (x.ok) log(`✓ ${x.name}：返回 ${x.n} 个，其中带蓝 V 标记字段的 ${x.withBlueFlag} 个、付费蓝 V ${x.blue} 个`, 'ok');
        else log(`✗ ${x.name}：${x.message}`, 'err');
      }
    } catch (e) { log(connMsg(e), 'err'); }
  });
}

/* ================= 本地数据校验 ================= */

// storage 可能是旧版本、被手改过、或写到一半中断的；直接信任会在启动时抛错白屏。
function sanitizeWhitelist(list) {
  return (Array.isArray(list) ? list : []).map((w) => {
    const id = w && /^\d+$/.test(String(w.id)) ? String(w.id) : null;
    const raw = String((w && w.h) || '').replace(/^@/, '').trim();
    return {
      id,
      h: HANDLE_RE.test(raw) ? raw : (id || ''),
      n: String((w && w.n) || raw || ''),
      a: w && typeof w.a === 'string' && w.a.startsWith('https://') ? w.a : '',
      at: Number.isFinite(w && w.at) ? w.at : 0,
    };
  }).filter((w) => w.id || w.h);
}

function sanitizeScan(sc) {
  if (!sc || typeof sc !== 'object' || !Array.isArray(sc.followers) || !Array.isArray(sc.following)) return null;
  const clean = (arr) => arr.filter((u) => u && typeof u.id === 'string' && /^\d+$/.test(u.id)).map((u) => ({
    ...u,
    h: typeof u.h === 'string' && u.h ? u.h : String(u.id),
    n: typeof u.n === 'string' && u.n ? u.n : (typeof u.h === 'string' && u.h ? u.h : String(u.id)),
    a: typeof u.a === 'string' ? u.a : '',
  }));
  const out = { ...sc, followers: clean(sc.followers), following: clean(sc.following) };
  for (const k of ['followerIds', 'followingIds']) {
    if (Array.isArray(out[k])) out[k] = out[k].map(String).filter((x) => /^\d+$/.test(x));
  }
  return out;
}

function sanitizeHistory(list) {
  return (Array.isArray(list) ? list : []).filter((r) =>
    r && typeof r.id === 'string' && typeof r.h === 'string' &&
    typeof r.t === 'number' && (r.op === 'follow' || r.op === 'unfollow'));
}

async function registerTab() {
  try {
    const t = await chrome.tabs.getCurrent();
    if (t && typeof t.id === 'number') await chrome.storage.local.set({ [TAB_KEY]: t.id });
  } catch (_) { /* 不是标签页环境就跳过 */ }
}

async function init() {
  const o = await chrome.storage.local.get(['xfh_settings', 'xfh_whitelist', 'xfh_whitelist_rev', 'xfh_scan', 'xfh_firstSeen', 'xfh_daily', 'xfh_history', 'xfh_queue', 'xfh_cooldown', 'xfh_auto']);
  const stored = o.xfh_settings && typeof o.xfh_settings === 'object' ? o.xfh_settings : {};
  S.settings = { ...DEFAULTS, ...stored };
  const flipped = stored._v !== 2 && stored.wlVerified === true;
  if (stored._v !== 2) { S.settings.wlVerified = false; S.settings._v = 2; store.set('xfh_settings', S.settings); }   // 一次性：“不取关认证账号”改为默认关闭
  S.whitelist = await initWl(o.xfh_whitelist, o.xfh_whitelist_rev);
  S.scan = sanitizeScan(o.xfh_scan);
  S.firstSeen = o.xfh_firstSeen && typeof o.xfh_firstSeen === 'object' ? o.xfh_firstSeen : {};
  S.daily = o.xfh_daily && typeof o.xfh_daily === 'object' ? o.xfh_daily : null;
  S.history = sanitizeHistory(o.xfh_history);
  S.queue = o.xfh_queue && Array.isArray(o.xfh_queue.items) ? o.xfh_queue : null;
  S.cooldown = o.xfh_cooldown && typeof o.xfh_cooldown === 'object' ? o.xfh_cooldown : null;
  S.auto = { ...S.auto, ...(o.xfh_auto && typeof o.xfh_auto === 'object' ? o.xfh_auto : {}) };
  if (S.queue && S.queue.auto) { S.queue = null; store.remove('xfh_queue'); }   // 上次中断的自动任务不续跑，下一轮重新计算

  rebuildWl(); rebuildScanMap(); computeStats();
  buildForm(); bind();
  $('#wlSearch').value = '';   // 别让浏览器恢复的旧搜索词把白名单列表过滤成空白
  const aboutVer = $('#aboutVer');
  if (aboutVer) aboutVer.textContent = 'v' + chrome.runtime.getManifest().version;
  recompute(false);
  route();
  renderAll();
  const primary = await claimEngine();
  if (primary) await registerTab();   // 只让主实例登记 tabId，只读副本不要抢
  if (flipped) log('“不取关认证账号”已改为默认关闭（认证账号很常见，不代表重要）。需要保留的话可以在设置里重新打开，或把具体账号加入白名单。', 'dim');
  if (!primary) return;
  checkConn();
  if (S.queue && S.queue.items.length) log(`检测到未完成的任务，还剩 ${S.queue.items.length} 个。`, 'warn');
  if (S.auto.enabled) {
    if (!S.auto.nextRun) scheduleNext(30e3);
    log(`[自动] 全自动模式开启中，下次检查约 ${hhmm(S.auto.nextRun)}`);
  }
  autoLoop();
}

init();
