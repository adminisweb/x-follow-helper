const BASE = chrome.runtime.getURL('dashboard.html');
const TAB_KEY = 'xfh_dashboard_tab';

// 找到已经打开的仪表盘：
// 1. 优先用 runtime.getContexts（不需要 tabs 权限，也不会拿错标签页）；
// 2. 旧版 Chrome 没有这个 API 时，退回 dashboard 自己写进 storage 的 tabId。
// 不能再依赖 chrome.tabs.query({url: chrome-extension://...})：没有 tabs
// 权限时 url 过滤不生效，tabs[0] 可能是任意标签页。
async function findDashboardTab() {
  if (typeof chrome.runtime.getContexts === 'function') {
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const list = contexts.filter((c) => typeof c.tabId === 'number' && c.tabId >= 0 &&
        typeof c.documentUrl === 'string' && c.documentUrl.startsWith(BASE));
      if (!list.length) return null;
      const stored = (await chrome.storage.local.get(TAB_KEY))[TAB_KEY];
      const hit = list.find((c) => c.tabId === stored) || list[0];
      return hit.tabId;
    } catch (_) { /* 继续用 storage 兜底 */ }
  }

  const id = (await chrome.storage.local.get(TAB_KEY))[TAB_KEY];
  if (typeof id === 'number') {
    try { await chrome.tabs.get(id); return id; } catch (_) { /* 标签页已关闭 */ }
  }
  return null;
}

async function openDashboard(target) {
  const url = BASE + '#' + target;
  const tabId = await findDashboardTab();
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tab.id, { url, active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) { /* 窗口聚焦失败不影响打开 */ }
      window.close();
      return;
    } catch (_) { /* 标签页没了，开新的 */ }
  }
  await chrome.tabs.create({ url });
  window.close();
}

function go(target) {
  openDashboard(target).catch((e) => {
    console.error(e);
    window.alert('无法打开仪表盘：' + ((e && e.message) || e));
  });
}

document.querySelectorAll('[data-go]').forEach((node) => {
  node.addEventListener('click', () => go(node.dataset.go));
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(node.dataset.go); });
});
