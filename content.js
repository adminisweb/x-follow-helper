/* X 互关助手 · content script
 *
 * 只做一件事：在 x.com 页面的同源环境里，替仪表盘页面调用 X 网页端自己用的接口。
 * 这样请求自带登录态和正确的 Origin，扩展本身不需要 cookies 权限，也不读取、保存任何 token。
 *
 * 接口层集中在本文件。X 改版后最可能出问题的是 Followers/Following 的 GraphQL 调用，
 * 出错时会把 HTTP 状态码、X 返回的错误码和消息原样带回仪表盘日志，方便定位。
 */
(() => {
  'use strict';
  if (window.__xfhLoaded) return;
  window.__xfhLoaded = true;

  // X 网页端公开使用的 Bearer（所有访问者相同）。优先从页面脚本里实时提取，提取不到才用这个。
  const FALLBACK_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const DEFAULT_FEATURES = {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };

  const OPS_KEY = 'xfh_ops';
  const OPS_TTL = 12 * 3600 * 1000;
  const OPS_VER = 3;   // 3：支持新版 X 的 Relay artifact（params.id + followersQuery），旧缓存作废
  let opsCache = null;

  class ApiError extends Error {
    constructor(info) {
      super(info.message || '请求失败');
      Object.assign(this, info);
    }
  }

  /* ---------- 基础工具 ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
  }

  function myId() {
    const twid = getCookie('twid');
    const m = twid && twid.match(/u=(\d+)/);
    return m ? m[1] : null;
  }

  function myHandle() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = a && a.getAttribute('href');
    if (href) return href.replace(/^\//, '').split(/[/?#]/)[0];
    // 新版布局/侧栏收起时，从头像按钮的文字里退而求其次
    const acct = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const m = acct && String(acct.textContent || '').match(/@(\w{1,15})/);
    return m ? m[1] : null;
  }

  function bearer() {
    return (opsCache && opsCache.bearer) || FALLBACK_BEARER;
  }

  function headers(extra) {
    return Object.assign({
      authorization: 'Bearer ' + bearer(),
      'x-csrf-token': getCookie('ct0') || '',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'zh-cn',
    }, extra || {});
  }

  // 明确表示“这个目标账号不能被操作”的错误码：跳过即可，不要当成整批任务失败。
  // 63 是目标用户被冻结（"User has been suspended"），不是自己的账号被封；
  // 64 才是自己的账号被冻结。162 被对方拉黑、179 无权查看、220 凭据不足单独处理。
  const SKIP_CODES = new Set([17, 34, 50, 63, 108, 158, 160, 162, 163, 179]);
  const AUTH_CODES = new Set([32, 89, 215, 220]);

  function errInfo(status, data, text, where) {
    const e = (data && data.errors && data.errors[0]) || {};
    const code = e.code;
    let message = e.message || (text || '').slice(0, 160) || ('HTTP ' + status);
    if (where) message = where + ' → ' + message;
    let kind = 'other';
    // 先判目标账号级错误，避免 "User has been suspended" 被下面的 regex 误判成自己受限
    if (SKIP_CODES.has(code)) kind = 'skip';
    else if (status === 429 || code === 88 || code === 161) kind = 'rate';
    else if (code === 64 || code === 326 || code === 226 ||
             /your account (?:is|has been) (?:locked|suspended)|temporarily locked|\bautomated\b/i.test(message)) kind = 'locked';
    else if (status === 401 || AUTH_CODES.has(code) || (status === 403 && /csrf/i.test(message))) kind = 'auth';
    if (status === 403 && kind === 'other') message += '（可能被 X 风控拦截；也可能是登录态/CSRF 失效）';
    return { kind, status, code, message };
  }

  async function xfetch(url, init) {
    const opts = Object.assign({ credentials: 'include' }, init || {});
    opts.headers = headers(init && init.headers);
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* 非 JSON */ }
    return { res, text, data };
  }

  /* ---------- 从页面脚本里发现 queryId / features / bearer ---------- */

  function scriptUrls() {
    const set = new Set();
    document.querySelectorAll('script[src]').forEach((s) => set.add(s.src));
    performance.getEntriesByType('resource').forEach((r) => set.add(r.name));
    const urls = [...set].filter((u) => /abs\.twimg\.com\/.*\.js(\?|$)/.test(u));
    const rank = (u) => (/\/(main|api|startup)[-.]/.test(u) ? 0 : 1);
    return urls.sort((a, b) => rank(a) - rank(b)).slice(0, 100);
  }

  // 老版 Web 客户端：{queryId:"...",operationName:"Followers",featureSwitches:[...]}
  const LEGACY_OP_RE = /queryId:"([\w-]+)",operationName:"(Followers|Following|UsersByRestIds|UserByRestId)"/g;
  // 新版 x-web（Relay artifact）：params:{id:`...`,metadata:{},name:`followersQuery`,operationKind:`query`}
  const RELAY_OP_RE = /params:\{id:[`"']([\w-]+)[`"'][\s\S]{0,240}?name:[`"'](followersQuery|followingQuery|intentFollowUserByRestIdQuery)[`"']/g;
  const RELAY_NAMES = { followersQuery: 'FollowersV2', followingQuery: 'FollowingV2', intentFollowUserByRestIdQuery: 'UserByRestIdV2' };
  const hasListOps = (o) => !!(o && o.ops && (o.ops.Followers || o.ops.FollowersV2) && (o.ops.Following || o.ops.FollowingV2));
  const hasAnyOps = (o) => !!(o && o.ops && Object.keys(o.ops).length);

  function scanText(text, found) {
    let m;
    const legacy = new RegExp(LEGACY_OP_RE.source, 'g');
    while ((m = legacy.exec(text))) {
      let tail = text.slice(m.index, m.index + 1500);
      const next = tail.indexOf('queryId:', 10);
      if (next > 0) tail = tail.slice(0, next);
      const fm = tail.match(/featureSwitches:\[([^\]]*)\]/);
      found.ops[m[2]] = {
        id: m[1],
        name: m[2],
        style: 'legacy',
        features: fm ? [...fm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [],
      };
    }
    const relay = new RegExp(RELAY_OP_RE.source, 'g');
    while ((m = relay.exec(text))) {
      found.ops[RELAY_NAMES[m[2]]] = { id: m[1], name: m[2], style: 'relay', features: [] };
    }
  }

  async function fetchText(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  async function discover() {
    const found = { v: OPS_VER, ops: {}, bearer: null, at: Date.now() };
    const urls = scriptUrls();
    const deadline = Date.now() + 45000;
    let next = 0;
    // 小并发抓取：串行下载几十个 bundle 会让首次扫描好几分钟没有反应
    const worker = async () => {
      for (;;) {
        if (Date.now() > deadline || hasListOps(found)) return;
        const i = next++;
        if (i >= urls.length) return;
        let text;
        try { text = await fetchText(urls[i], 12000); } catch (_) { continue; }
        if (hasListOps(found)) return;
        scanText(text, found);
        if (!found.bearer) {
          const bm = text.match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{40,})"/);
          if (bm) found.bearer = bm[1];
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, urls.length) }, worker));
    if (!hasAnyOps(found)) {
      throw new ApiError({
        kind: 'stale',
        message: '没能从 X 页面脚本里找到 Followers/Following 的查询 ID。' +
          '如果 x.com 是新版界面，请先打开你自己的主页，点开“粉丝”和“关注”列表各一次（让 X 加载对应代码块），再回来重试；' +
          '老版界面则刷新 x.com 后重试。',
      });
    }
    return found;
  }

  async function saveOps() {
    try { await chrome.storage.local.set({ [OPS_KEY]: opsCache }); } catch (_) { /* ignore */ }
  }

  async function getOps(force) {
    if (!force && opsCache && opsCache.v === OPS_VER && Date.now() - opsCache.at < OPS_TTL) return opsCache;
    if (!force) {
      try {
        const o = (await chrome.storage.local.get(OPS_KEY))[OPS_KEY];
        if (o && o.v === OPS_VER && hasAnyOps(o) && Date.now() - o.at < OPS_TTL) {
          opsCache = o;
          return opsCache;
        }
      } catch (_) { /* ignore */ }
    }
    opsCache = await discover();
    await saveOps();
    return opsCache;
  }

  function buildFeatures(list) {
    const out = {};
    if (list && list.length) for (const n of list) out[n] = DEFAULT_FEATURES[n] !== undefined ? DEFAULT_FEATURES[n] : false;
    else Object.assign(out, DEFAULT_FEATURES);
    return out;
  }

  /* ---------- GraphQL ---------- */

  async function gql(op, variables) {
    let force = false;
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ops = await getOps(force);
      force = false;
      const def = ops.ops[op];
      if (!def) throw new ApiError({ kind: 'stale', message: '没有 ' + op + ' 的 queryId' });
      // 新版 Relay 查询默认不带 features；只有服务端明确报缺哪个时才补成 false
      const features = def.style === 'relay'
        ? Object.fromEntries((def.features || []).map((n) => [n, false]))
        : buildFeatures(def.features);
      const opName = def.name || op;      // URL 里的 operationName 必须是 X 的真实名字（如 followersQuery）
      let url = location.origin + '/i/api/graphql/' + def.id + '/' + opName +
        '?variables=' + encodeURIComponent(JSON.stringify(variables)) +
        '&features=' + encodeURIComponent(JSON.stringify(features));
      const toggles = def.fieldToggles || {};
      if (Object.keys(toggles).length) url += '&fieldToggles=' + encodeURIComponent(JSON.stringify(toggles));
      const { res, text, data } = await xfetch(url, { method: 'GET' });
      if (res.ok && data && data.data) return data;

      last = errInfo(res.status, data, text, 'GraphQL ' + op);
      if (last.kind === 'rate' || last.kind === 'locked' || last.kind === 'auth') break;

      // X 会明确告诉我们缺哪些 feature：补成 false 再试一次
      const miss = text.match(/features cannot be null: ([\w,\s]+)/i);
      if (res.status === 400 && miss) {
        for (const n of miss[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!def.features.includes(n)) def.features.push(n);
        }
        await saveOps();
        continue;
      }
      const missT = text.match(/fieldToggles cannot be null: ([\w,\s]+)/i);
      if (res.status === 400 && missT) {
        def.fieldToggles = def.fieldToggles || {};
        for (const n of missT[1].split(',').map((s) => s.trim()).filter(Boolean)) def.fieldToggles[n] = false;
        await saveOps();
        continue;
      }
      // 只有 404/400 才值得重新发现 queryId；403、200-with-errors 等直接抛，避免连打
      if (res.status === 404 || res.status === 400) {
        force = true;
        await sleep(400);
        continue;
      }
      break;
    }
    throw new ApiError(last || { kind: 'other', message: '请求失败' });
  }

  function firstNum(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }

  // X 把粉丝数、关注数、帖子数从 legacy 挪到了 relationship_counts / tweet_counts 等位置
  function countOf(r, keys) {
    const n = firstNum(r, keys);
    if (n != null) return n;
    const bags = [r.legacy, r.core, r.relationship_counts, r.relationshipCounts, r.tweet_counts, r.tweetCounts, r.action_counts];
    for (const bag of bags) {
      const v = firstNum(bag, keys);
      if (v != null) return v;
    }
    for (const k of Object.keys(r)) {
      if (k === 'legacy' || k === 'core' || k === 'timeline' || k === 'professional' || k === 'affiliates_highlighted_label') continue;
      const v = r[k];
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const hit = firstNum(v, keys);
      if (hit != null) return hit;
    }
    return null;
  }

  function normUser(r) {
    if (!r || r.__typename === 'UserUnavailable' || !r.rest_id) return null;
    const l = r.legacy || {};
    const c = r.core || {};
    const h = c.screen_name || l.screen_name;
    if (!h) return null;
    const avatar = (r.avatar && r.avatar.image_url) || l.profile_image_url_https || '';
    return {
      id: String(r.rest_id),
      h,
      n: c.name || l.name || h,
      a: avatar,
      fo: countOf(r, ['followers_count', 'followers', 'normal_followers_count']),
      fi: countOf(r, ['friends_count', 'following_count', 'following']),
      t: countOf(r, ['statuses_count', 'tweets_count', 'tweets', 'posts_count']),
      v: !!(r.is_blue_verified || l.verified || (r.verification && r.verification.verified)),
      b: !!r.is_blue_verified,   // 付费蓝 V（Premium / 认证组织），不含旧版认证
      p: !!((r.privacy && r.privacy.protected) || l.protected),
      d: !!(l.default_profile_image || /default_profile/.test(avatar)),
    };
  }

  // 兼容两种返回结构：
  // 老版：data.user.result.timeline.timeline.instructions
  // 新版：data.user_result_by_screen_name.result.followers_timeline.timeline.instructions
  function parseUsers(json, kind = 'followers', style = 'legacy') {
    const result = style === 'relay'
      ? (json && json.data && json.data.user_result_by_screen_name && json.data.user_result_by_screen_name.result)
      : (json && json.data && json.data.user && json.data.user.result);
    const tlKey = kind === 'followers' ? 'followers_timeline' : 'following_timeline';
    const box = result && (result.timeline || result[tlKey]);
    const instructions = (box && box.timeline && box.timeline.instructions) || [];
    const users = [];
    let next = null;
    for (const ins of instructions) {
      for (const e of ins.entries || []) {
        const eid = e.entryId || '';
        if (eid.startsWith('user-')) {
          const u = normUser(e.content && e.content.itemContent &&
            e.content.itemContent.user_results && e.content.itemContent.user_results.result);
          if (u) users.push(u);
        } else if (eid.startsWith('cursor-bottom-')) {
          next = (e.content && e.content.value) || null;
        }
      }
    }
    // 返回结构再变时兜底：从整个 JSON 里找带 rest_id 的用户节点
    if (!users.length) users.push(...usersFromGql(json));
    return { users, next };
  }

  async function gqlList(kind, cursor, count) {
    let ops = await getOps(false);
    const legacy = kind === 'followers' ? 'Followers' : 'Following';
    const relay = kind === 'followers' ? 'FollowersV2' : 'FollowingV2';
    // 缓存可能只含 UserByRestIdV2（当时列表代码块还没加载）；缺列表接口时强制重新发现
    if (!ops.ops[legacy] && !ops.ops[relay]) ops = await getOps(true);
    const attempts = [];
    if (ops.ops[legacy]) attempts.push(legacy);
    if (ops.ops[relay]) attempts.push(relay);
    if (!attempts.length) {
      throw new ApiError({
        kind: 'stale',
        message: '页面脚本里没有 ' + kind + ' 的查询 ID。如果 x.com 是新版界面，请先在 x.com 打开你自己的主页，点开“粉丝”和“关注”列表各一次，再回来重试。',
      });
    }

    let last = null;
    for (const op of attempts) {
      const isRelay = op.endsWith('V2');
      try {
        if (isRelay) {
          const h = myHandle();
          if (!h) throw new ApiError({ kind: 'auth', message: '新版 X 列表接口需要用户名，但页面上没读到；请刷新 x.com 标签页后重试' });
          const vars = { screenName: h, count: Math.min(count || 100, 100) };
          if (cursor) vars.cursor = cursor;
          return parseUsers(await gql(op, vars), kind, 'relay');
        }
        const vars = { userId: myId(), count: count || 200, includePromotedContent: false };
        if (cursor) vars.cursor = cursor;
        return parseUsers(await gql(op, vars), kind, 'legacy');
      } catch (e) {
        last = e;
        if (e && (e.kind === 'rate' || e.kind === 'locked' || e.kind === 'auth')) throw e;
      }
    }
    throw last || new ApiError({ kind: 'other', message: '列表接口不可用' });
  }

  /* ---------- REST 1.1 列表（每页最多 200，不需要 queryId） ---------- */

  const V1_PATHS = {
    followers: ['followers/list.json'],
    following: ['friends/following/list.json', 'friends/list.json'],
  };
  const v1Good = {};   // 记住哪条路径可用

  function normV1(u) {
    if (!u || !u.id_str || !u.screen_name) return null;
    const hasBlue = u.ext_is_blue_verified !== undefined;
    return {
      id: String(u.id_str),
      h: u.screen_name,
      n: u.name || u.screen_name,
      a: u.profile_image_url_https || '',
      fo: u.followers_count !== undefined ? u.followers_count : null,
      fi: u.friends_count !== undefined ? u.friends_count : null,
      t: u.statuses_count !== undefined ? u.statuses_count : null,
      v: !!(u.ext_is_blue_verified || u.verified),
      b: hasBlue ? !!u.ext_is_blue_verified : undefined,   // 接口没返回时保持 undefined，不要当成 false
      p: !!u.protected,
      d: !!u.default_profile_image,
    };
  }

  function rawNext(text) {
    let m = text.match(/"next_cursor_str"\s*:\s*"(-?\d+)"/);
    if (m) return m[1];
    m = text.match(/"next_cursor"\s*:\s*(-?\d+)/);
    return m ? m[1] : null;
  }

  function parseV1(data, path, text) {
    const users = (data.users || []).map(normV1).filter(Boolean);
    const c = rawNext(text);
    return { users, next: c && c !== '0' ? c : null, meta: { path, rawNext: c } };
  }

  async function v1Fetch(path, cursor, count) {
    const q = new URLSearchParams({
      include_profile_interstitial_type: '1',
      include_blocking: '1',
      include_blocked_by: '1',
      include_followed_by: '1',
      include_want_retweets: '1',
      include_mute_edge: '1',
      include_can_dm: '1',
      include_can_media_tag: '1',
      include_ext_is_blue_verified: '1',
      include_ext_verified_type: '1',
      include_ext_profile_image_shape: '1',
      skip_status: '1',
      cursor: cursor || '-1',
      user_id: String(myId()),
      count: String(count || 200),
      with_total_count: 'true',
    });
    const { res, text, data } = await xfetch(location.origin + '/i/api/1.1/' + path + '?' + q.toString(), { method: 'GET' });
    if (res.ok && data && Array.isArray(data.users)) return parseV1(data, path, text);
    throw new ApiError(errInfo(res.status, data, text, 'REST ' + path));
  }

  const FATAL = ['rate', 'locked', 'auth'];

  async function v1List(kind, cursor, count) {
    const paths = V1_PATHS[kind];
    const order = v1Good[kind] ? [v1Good[kind]].concat(paths.filter((p) => p !== v1Good[kind])) : paths;
    let best = null, last = null;
    for (const p of order) {
      let r;
      try {
        r = await v1Fetch(p, cursor, count);
      } catch (e) {
        last = e;
        if (FATAL.includes(e.kind)) throw e;
        continue;
      }
      if (!best || r.users.length > best.users.length || (r.next && !best.next)) best = r;
      if (r.next || r.users.length < 190) break;   // 有下一页，或确实已是最后一页
      // 满页却没有下一页游标：这条路径可能有限制，再试另一条
    }
    if (best) { v1Good[kind] = best.meta.path; return best; }
    v1Good[kind] = null;
    throw last;
  }

  // 只取 ID（每页最多 5000，翻页稳定），用来在详情列表被截断时补全
  async function idsAll(kind) {
    const path = kind === 'followers' ? 'followers/ids.json' : 'friends/ids.json';
    const ids = [];
    let cursor = '-1';
    for (let i = 0; i < 40; i++) {
      const q = new URLSearchParams({ user_id: String(myId()), count: '5000', stringify_ids: 'true', cursor });
      const { res, text, data } = await xfetch(location.origin + '/i/api/1.1/' + path + '?' + q.toString(), { method: 'GET' });
      if (!(res.ok && data && Array.isArray(data.ids))) throw new ApiError(errInfo(res.status, data, text, 'REST ' + path));
      for (const id of data.ids) {
        // 数字形式的 ID 超过 2^53 会在 JSON.parse 时失真，宁可报错也不要用错的 ID
        if (typeof id !== 'string') throw new ApiError({ kind: 'other', message: path + ' 没有返回字符串形式的 ID，无法安全使用' });
        ids.push(id);
      }
      const c = rawNext(text);
      if (!c || c === '0') break;
      cursor = c;
      await sleep(1500);
    }
    return { ok: true, ids: Array.from(new Set(ids)) };
  }

  // 从 GraphQL 响应里收集用户。网页上的 users/lookup.json 已不存在（404 / code 34）。
  function usersFromGql(json) {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.rest_id === 'string' && (node.legacy || node.core || node.__typename === 'User')) {
        const u = normUser(node);
        if (u && !seen.has(u.id)) { seen.add(u.id); out.push(u); }
        return;
      }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      for (const k of Object.keys(node)) if (k !== 'errors') walk(node[k]);
    };
    walk(json && json.data);
    return out;
  }

  async function showOne(id) {
    const q = new URLSearchParams({
      user_id: String(id),
      include_entities: 'false',
      skip_status: 'true',
      include_ext_is_blue_verified: '1',
      include_ext_verified_type: '1',
    });
    const { res, text, data } = await xfetch(location.origin + '/i/api/1.1/users/show.json?' + q.toString(), { method: 'GET' });
    if (res.ok && data && data.id_str) return { user: normV1(data) };
    const info = errInfo(res.status, data, text, 'REST users/show');
    if (info.code === 17 || (info.kind === 'skip' && info.code !== 34)) return { gone: true };
    throw new ApiError(info);
  }

  // 按 ID 取资料（每次最多 100 个）。优先网页 GraphQL 批量接口，失败再逐个 users/show。
  async function lookup(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((x) => /^\d+$/.test(x)).slice(0, 100);
    if (!list.length) return { ok: true, users: [], gone: [] };

    let batchErr = null;
    try {
      const ops = await getOps(false);
      if (ops.ops.UsersByRestIds) {
        const json = await gql('UsersByRestIds', { userIds: list });
        const users = usersFromGql(json);
        if (users.length) return { ok: true, users, gone: [], via: 'UsersByRestIds' };
        batchErr = 'UsersByRestIds 没有返回用户';
      } else if (ops.ops.UserByRestId && list.length === 1) {
        const json = await gql('UserByRestId', { userId: list[0], withSafetyModeUserFields: true });
        const users = usersFromGql(json);
        if (users.length) return { ok: true, users, gone: [], via: 'UserByRestId' };
        batchErr = 'UserByRestId 没有返回用户';
      } else batchErr = '页面脚本里没有 UsersByRestIds';
    } catch (e) {
      if (FATAL.includes(e.kind)) throw e;
      batchErr = e.message || String(e);
    }

    const users = [];
    const gone = [];
    let showErr = null;
    for (let i = 0; i < list.length; i++) {
      let one;
      try { one = await showOne(list[i]); }
      catch (e) {
        if (FATAL.includes(e.kind)) throw e;
        // 整条路由不存在时，不要把剩下的 ID 再打一遍
        if (e.code === 34 && !users.length && !gone.length) { showErr = e; break; }
        if (!users.length && !gone.length && i >= 2) { showErr = e; break; }
        showErr = e;
        continue;
      }
      if (one.gone) gone.push(list[i]);
      else if (one.user) users.push(one.user);
      if (i + 1 < list.length) await sleep(200);
    }
    if (users.length || (gone.length && !showErr)) return { ok: true, users, gone, via: 'users/show' };

    // users/show 不通时，先用新版页面的 user_result_by_rest_id 查询（只有基础资料），再走老版 UserByRestId
    let singleErr = showErr;
    try {
      const ops = await getOps(false);
      if (ops.ops.UserByRestIdV2) {
        const got = [];
        const missing = [];
        let fail = 0;
        for (let i = 0; i < list.length; i++) {
          try {
            const json = await gql('UserByRestIdV2', { userId: list[i] });
            const u = usersFromGql(json);
            if (u.length) got.push(u[0]);
            else missing.push(list[i]);
            fail = 0;
          } catch (e) {
            if (FATAL.includes(e.kind)) throw e;
            if (e.code === 17 || (e.kind === 'skip' && e.code !== 34)) { missing.push(list[i]); continue; }
            fail++;
            singleErr = e;
            if (fail >= 3 && !got.length) break;
          }
          if (i + 1 < list.length) await sleep(200);
        }
        if (got.length || (missing.length && fail < 3)) return { ok: true, users: got, gone: missing, via: 'UserByRestIdV2' };
      }
    } catch (e) {
      if (FATAL.includes(e.kind)) throw e;
      singleErr = e;
    }
    try {
      const ops = await getOps(false);
      if (ops.ops.UserByRestId) {
        const got = [];
        const missing = [];
        let fail = 0;
        for (let i = 0; i < list.length; i++) {
          try {
            const json = await gql('UserByRestId', { userId: list[i], withSafetyModeUserFields: true });
            const u = usersFromGql(json);
            if (u.length) got.push(u[0]);
            else missing.push(list[i]);
            fail = 0;
          } catch (e) {
            if (FATAL.includes(e.kind)) throw e;
            // code 34 是路由不存在，不是这个用户注销了
            if (e.code === 17 || (e.kind === 'skip' && e.code !== 34)) { missing.push(list[i]); continue; }
            fail++;
            singleErr = e;
            if (fail >= 3 && !got.length) break;
          }
          if (i + 1 < list.length) await sleep(200);
        }
        if (got.length || (missing.length && fail < 3)) return { ok: true, users: got, gone: missing, via: 'UserByRestId' };
      }
    } catch (e) {
      if (FATAL.includes(e.kind)) throw e;
      singleErr = e;
    }

    const why = (singleErr && singleErr.message) || batchErr || '按 ID 查资料失败';
    throw new ApiError({ kind: (singleErr && singleErr.kind) || 'other', status: singleErr && singleErr.status, code: singleErr && singleErr.code, message: why });
  }

  // X 资料里显示的粉丝数 / 关注数，用来核对扫描是否完整
  async function me() {
    const id = myId();
    const tries = [
      'account/verify_credentials.json?skip_status=true&include_entities=false',
      'users/show.json?include_entities=false&user_id=' + id,
    ];
    let last = null;
    for (const p of tries) {
      const { res, text, data } = await xfetch(location.origin + '/i/api/1.1/' + p, { method: 'GET' });
      if (res.ok && data && data.friends_count !== undefined) {
        return { ok: true, followers: data.followers_count, following: data.friends_count, handle: data.screen_name };
      }
      last = errInfo(res.status, data, text, 'REST ' + p.split('?')[0]);
    }
    throw new ApiError(last);
  }

  // 首页优先走 REST 1.1；失败再试 GraphQL。后续翻页按 cursor 的形状选同一种接口。
  // via === 'gql' 时从头用 GraphQL（REST 的数字游标不能传给 GraphQL）。
  async function list(kind, cursor, via) {
    if (!myId()) throw new ApiError({ kind: 'auth', message: '读取不到登录信息（twid），请确认这个标签页已登录 X' });
    if (via === 'gql') return gqlList(kind, cursor);
    if (cursor) return /^-?\d+$/.test(cursor) ? v1List(kind, cursor) : gqlList(kind, cursor);
    try {
      return await v1List(kind, null);
    } catch (e1) {
      if (FATAL.includes(e1.kind)) throw e1;
      try {
        return await gqlList(kind, null);
      } catch (e2) {
        if (FATAL.includes(e2.kind)) throw e2;
        throw new ApiError({ kind: 'other', status: e2.status, code: e2.code, message: e1.message + '；' + e2.message });
      }
    }
  }

  // 逐个接口试一遍，把结果原样报告，方便定位是哪条路被 X 拒绝
  async function probe() {
    const results = [];
    const one = async (name, fn) => {
      try {
        const r = await fn();
        results.push({
          name, ok: true, n: r.users.length,
          withBlueFlag: r.users.filter((u) => u.b !== undefined).length,
          blue: r.users.filter((u) => u.b === true).length,
        });
      } catch (e) {
        results.push({ name, ok: false, message: String((e && e.message) || e) });
      }
    };
    await one('REST followers/list', () => v1Fetch('followers/list.json', null, 20));
    await one('REST friends/following/list', () => v1Fetch('friends/following/list.json', null, 20));
    await one('REST friends/list', () => v1Fetch('friends/list.json', null, 20));
    await one('GraphQL Followers', () => gqlList('followers', null, 20));
    await one('GraphQL Following', () => gqlList('following', null, 20));
    try {
      const r = await lookup([String(myId())]);
      results.push({
        name: '按 ID 查自己' + (r.via ? '（' + r.via + '）' : ''),
        ok: true,
        n: (r.users || []).length,
        withBlueFlag: (r.users || []).filter((u) => u.b !== undefined).length,
        blue: (r.users || []).filter((u) => u.b === true).length,
      });
    } catch (e) {
      results.push({ name: '按 ID 查自己', ok: false, message: String((e && e.message) || e) });
    }
    return { ok: true, results };
  }

  /* ---------- 关注 / 取关（1.1 接口，不需要 queryId） ---------- */

  async function friendship(kind, id) {
    if (!/^\d+$/.test(String(id))) throw new ApiError({ kind: 'other', message: '无效的用户 ID' });
    const body = new URLSearchParams({
      include_profile_interstitial_type: '1',
      include_blocking: '1',
      include_blocked_by: '1',
      include_followed_by: '1',
      include_want_retweets: '1',
      include_mute_edge: '1',
      include_can_dm: '1',
      include_can_media_tag: '1',
      include_ext_is_blue_verified: '1',
      include_ext_verified_type: '1',
      include_ext_profile_image_shape: '1',
      skip_status: '1',
      user_id: String(id),
    });
    const url = location.origin + '/i/api/1.1/friendships/' + (kind === 'follow' ? 'create' : 'destroy') + '.json';
    const { res, text, data } = await xfetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.ok && !(data && data.errors)) return { ok: true };
    throw new ApiError(errInfo(res.status, data, text));
  }

  /* ---------- 与仪表盘页面通信 ---------- */

  async function handle(msg) {
    switch (msg.op) {
      case 'ping':
        return { ok: true, me: myId(), handle: myHandle(), csrf: !!getCookie('ct0') };
      case 'list': {
        if (msg.kind !== 'followers' && msg.kind !== 'following') throw new Error('bad kind');
        const r = await list(msg.kind, typeof msg.cursor === 'string' ? msg.cursor : null, msg.via === 'gql' ? 'gql' : '');
        return { ok: true, users: r.users, next: r.next, meta: r.meta || null };
      }
      case 'follow':
      case 'unfollow':
        return friendship(msg.op, msg.id);
      case 'diag': {
        const o = await getOps(true);
        const ops = {};
        for (const k of Object.keys(o.ops)) ops[k] = { id: o.ops[k].id, style: o.ops[k].style || 'legacy', features: o.ops[k].features.length };
        return { ok: true, ops, bearerFromPage: !!o.bearer, me: myId(), csrf: !!getCookie('ct0') };
      }
      case 'ids':
        if (!myId()) throw new ApiError({ kind: 'auth', message: '读取不到登录信息（twid）' });
        return idsAll(msg.kind === 'followers' ? 'followers' : 'following');
      case 'lookup':
        return lookup(msg.ids);
      case 'me':
        if (!myId()) throw new ApiError({ kind: 'auth', message: '读取不到登录信息（twid）' });
        return me();
      case 'probe':
        if (!myId()) throw new ApiError({ kind: 'auth', message: '读取不到登录信息（twid）' });
        return probe();
      case 'resetOps':
        opsCache = null;
        await chrome.storage.local.remove(OPS_KEY);
        return { ok: true };
      default:
        throw new Error('unknown op');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.xfh !== 1) return false;
    handle(msg).then(sendResponse, (e) => {
      if (e instanceof ApiError) {
        sendResponse({ ok: false, kind: e.kind, status: e.status, code: e.code, message: e.message });
      } else {
        sendResponse({ ok: false, kind: 'other', message: String((e && e.message) || e) });
      }
    });
    return true;
  });
})();
