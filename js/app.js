import * as store from './store.js';
import { TIER_LABEL, TIER_ORDER } from './store.js';
import * as sync from './sync.js';

const $ = (id) => document.getElementById(id);

const el = {
  screenList: $('screenList'),
  screenCompose: $('screenCompose'),
  screenDetail: $('screenDetail'),
  detailBody: $('detailBody'),
  detailTitle: $('detailTitle'),
  tabs: $('tabs'),
  text: $('composeText'),
  parentField: $('parentField'),
  parent: $('composeParent'),
  due: $('composeDue'),
  counter: $('counter'),
  post: $('btnPost'),
  chips: document.querySelectorAll('.chip'),
  timeline: $('timeline'),
  empty: $('empty'),
  showDone: $('showDone'),
  stat: $('stat'),
  badge: $('syncBadge'),
  avatar: $('avatar'),
  toast: $('toast'),
  sheet: $('sheet'),
  backdrop: $('sheetBackdrop'),
};

let view = 'all';
let tier = 'short';
let composeParentId = null;   // 投稿画面で既定にする上位タスク
let editingId = null;

/* ---------------- helpers ---------------- */

function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function relTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'いま';
  if (diff < 3600) return `${Math.floor(diff / 60)}分`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}日`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dueInfo(due) {
  if (!due) return null;
  const today = todayStr();
  const days = Math.round((new Date(due + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  let cls = '';
  let label = due.slice(5).replace('-', '/');
  if (days < 0) { cls = 'over'; label = `${label} (${-days}日超過)`; }
  else if (days === 0) { cls = 'soon'; label = `${label} (今日)`; }
  else if (days <= 3) { cls = 'soon'; label = `${label} (あと${days}日)`; }
  return { cls, label };
}

/* 期限 → 作成日時 の順で並べる */
function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return a.created_at < b.created_at ? 1 : -1;
  });
}

function visible() {
  const showDone = el.showDone.checked;
  return store.all().filter((t) => showDone || !t.done);
}

/* ---------------- テーマ ---------------- */

const THEME_KEY = 'taskapp.theme';
const darkMQ = matchMedia('(prefers-color-scheme: dark)');

function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'auto' || t === 'light' || t === 'dark') return t;
  } catch { /* noop */ }
  return 'auto';
}

/** 'auto' | 'light' | 'dark' を :root に反映する */
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;

  const dark = t === 'dark' || (t === 'auto' && darkMQ.matches);
  $('metaTheme').content = dark ? '#15181c' : '#ffffff';

  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    const on = b.dataset.themeChoice === t;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

function setTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* noop */ }
  applyTheme(t);
}

/* ---------------- composer ---------------- */

function setTier(next) {
  tier = next;
  for (const c of el.chips) {
    const on = c.dataset.tier === next;
    c.classList.toggle('is-on', on);
    c.setAttribute('aria-checked', String(on));
  }
  refreshParentOptions();
}

function parentCandidates(forTier) {
  const tiers = store.parentTiers(forTier);
  return store
    .all()
    .filter((t) => tiers.includes(t.tier) && !t.done)
    .sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (a.created_at < b.created_at ? -1 : 1));
}

function refreshParentOptions() {
  if (!store.parentTiers(tier).length) {
    el.parentField.hidden = true;
    el.parent.replaceChildren();   // 値を残さない (長期に親が付くのを防ぐ)
    return;
  }
  const cands = parentCandidates(tier);
  el.parentField.hidden = false;
  el.parent.replaceChildren();
  el.parent.append(new Option(cands.length ? '— なし —' : '— 上位タスクがまだありません —', ''));
  for (const c of cands) {
    el.parent.append(new Option(`[${TIER_LABEL[c.tier]}] ${c.body.slice(0, 40)}`, c.id));
  }

  if (!composeParentId) return;
  const want = store.byId(composeParentId);
  // 完了済みの親から「下位タスクを追加」した場合も選べるようにしておく
  if (want && !cands.some((c) => c.id === want.id) && store.parentTiers(tier).includes(want.tier)) {
    el.parent.append(new Option(`[${TIER_LABEL[want.tier]}] ${want.body.slice(0, 40)}`, want.id));
  }
  el.parent.value = composeParentId;
  if (el.parent.value !== composeParentId) composeParentId = el.parent.value || null;  // 枠を変えて無効になった
}

function autoGrow() {
  el.text.style.height = 'auto';
  el.text.style.height = Math.min(el.text.scrollHeight, 320) + 'px';
}

function updateCounter() {
  const n = el.text.value.length;
  el.counter.textContent = `${n} / 500`;
  el.post.disabled = el.text.value.trim().length === 0;
}

function post() {
  const text = el.text.value.trim();
  if (!text) return;
  const parentId = store.parentTiers(tier).length ? (el.parent.value || null) : null;
  const parentTier = parentId ? store.byId(parentId)?.tier ?? null : null;
  store.create({ tier, text, parentId, parentTier, due: el.due.value || null });
  el.text.value = '';
  el.due.value = '';
  autoGrow();
  updateCounter();
  toast(`${TIER_LABEL[tier]}タスクを追加しました`);
  sync.syncNow().catch(() => {});
  goBack();
}

/* ---------------- card ---------------- */

function parentChain(task) {
  const chain = [];
  let cur = task;
  const seen = new Set();
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const p = store.byId(cur.parent_id);
    if (!p) break;
    chain.unshift(p);
    cur = p;
  }
  return chain;
}

function renderCard(t, { link = true, root = false } = {}) {
  const card = document.createElement('article');
  card.className = 'card' + (t.done ? ' is-done' : '');
  card.dataset.id = t.id;

  const check = document.createElement('button');
  check.className = 'check';
  check.textContent = '✓';
  check.setAttribute('aria-label', t.done ? '未完了に戻す' : '完了にする');
  check.addEventListener('click', () => { store.toggleDone(t.id); sync.syncNow().catch(() => {}); });
  card.append(check);

  const main = document.createElement('div');
  main.className = 'card-main' + (link ? ' is-linked' : '');
  if (link) {
    main.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;  // 操作系は素通し
      openDetail(t.id);
    });
  }

  const head = document.createElement('div');
  head.className = 'card-head';
  const badge = document.createElement('span');
  badge.className = `tier tier-${t.tier}`;
  badge.textContent = TIER_LABEL[t.tier];
  head.append(badge);
  const time = document.createElement('span');
  time.textContent = relTime(t.created_at);
  time.title = new Date(t.created_at).toLocaleString('ja-JP');
  head.append(time);
  const di = dueInfo(t.due);
  if (di) {
    const d = document.createElement('span');
    d.className = `card-due dot ${di.cls}`;
    d.textContent = '期限 ' + di.label;
    head.append(d);
  }
  main.append(head);

  if (editingId === t.id) {
    const ta = document.createElement('textarea');
    ta.className = 'card-text';
    ta.value = t.body;
    ta.rows = Math.min(8, t.body.split('\n').length + 1);
    ta.style.width = '100%';
    main.append(ta);

    const dueEdit = document.createElement('input');
    dueEdit.type = 'date';
    dueEdit.value = t.due ?? '';
    dueEdit.style.marginTop = '8px';

    const relink = document.createElement('select');
    relink.style.marginTop = '8px';
    const cands = parentCandidates(t.tier).filter((c) => c.id !== t.id);
    const cur = t.parent_id ? store.byId(t.parent_id) : null;
    if (cur && !cands.some((c) => c.id === cur.id)) cands.unshift(cur); // 完了済みの親も残す
    if (store.parentTiers(t.tier).length) {
      relink.append(new Option('— 上位タスクなし —', ''));
      for (const c of cands) relink.append(new Option(`[${TIER_LABEL[c.tier]}] ${c.body.slice(0, 40)}`, c.id));
      if (t.parent_id) relink.value = t.parent_id;
    } else {
      relink.hidden = true;
    }

    const wrap = document.createElement('div');
    wrap.className = 'composer-meta';
    const f1 = document.createElement('label');
    f1.className = 'field';
    f1.append(Object.assign(document.createElement('span'), { className: 'field-label', textContent: '期限' }), dueEdit);
    wrap.append(f1);
    if (!relink.hidden) {
      const f2 = document.createElement('label');
      f2.className = 'field';
      f2.append(Object.assign(document.createElement('span'), { className: 'field-label', textContent: '紐づける上位タスク' }), relink);
      wrap.append(f2);
    }
    main.append(wrap);

    const acts = document.createElement('div');
    acts.className = 'card-actions';
    const save = document.createElement('button');
    save.className = 'act';
    save.textContent = '保存';
    save.addEventListener('click', () => {
      const body = ta.value.trim();
      if (!body) { toast('本文が空です'); return; }
      const pid = relink.hidden ? null : (relink.value || null);
      store.update(t.id, {
        body,
        due: dueEdit.value || null,
        parent_id: pid,
        parent_tier: pid ? store.byId(pid)?.tier ?? null : null,
      });
      editingId = null;
      render();
      sync.syncNow().catch(() => {});
    });
    const cancel = document.createElement('button');
    cancel.className = 'act';
    cancel.textContent = 'キャンセル';
    cancel.addEventListener('click', () => { editingId = null; render(); });
    acts.append(save, cancel);
    main.append(acts);
    card.append(main);
    return card;
  }

  const body = document.createElement('p');
  body.className = 'card-text';
  body.textContent = t.body;
  main.append(body);

  const chain = parentChain(t);
  if (chain.length) {
    const p = document.createElement('div');
    p.className = 'card-parent';
    p.append(document.createTextNode('↳ '));
    chain.forEach((c, i) => {
      if (i) p.append(document.createTextNode(' › '));
      const b = document.createElement('b');
      b.textContent = `${TIER_LABEL[c.tier]}: ${c.body.slice(0, 30)}`;
      p.append(b);
    });
    main.append(p);
  }

  const kids = root ? [] : store.children(t.id);
  if (kids.length) {
    const c = document.createElement('span');
    c.className = 'childcount';
    const doneN = kids.filter((k) => k.done).length;
    c.textContent = `下位タスク ${doneN}/${kids.length} 完了`;
    main.append(c);
  }

  const acts = document.createElement('div');
  acts.className = 'card-actions';
  const edit = document.createElement('button');
  edit.className = 'act';
  edit.textContent = '編集';
  edit.addEventListener('click', () => { editingId = t.id; render(); });
  const del = document.createElement('button');
  del.className = 'act danger';
  del.textContent = '削除';
  del.addEventListener('click', () => {
    if (!confirm('このタスクを削除します。下位タスクは残り、紐付けだけ外れます。')) return;
    store.remove(t.id);
    sync.syncNow().catch(() => {});
    toast('削除しました');
    if (root) goBack();
  });
  acts.append(edit, del);
  main.append(acts);

  card.append(main);
  return card;
}

/* ---------------- detail ---------------- */

function renderDetail(id) {
  const host = el.detailBody;
  host.replaceChildren();

  const t = store.byId(id);
  if (!t) {
    el.detailTitle.textContent = 'タスク';
    $('btnAddChild').hidden = true;
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'このタスクは見つかりません (削除された可能性があります)。';
    host.append(p);
    return;
  }

  el.detailTitle.textContent = `${TIER_LABEL[t.tier]}タスク`;
  const canHaveChildren = store.childTiers(t.tier).length > 0;
  $('btnAddChild').hidden = !canHaveChildren;

  host.append(renderCard(t, { link: false, root: true }));
  if (!canHaveChildren) return;

  const all = store.children(t.id);
  const head = document.createElement('div');
  head.className = 'section-head';
  head.textContent = all.length ? `下位タスク ${all.filter((k) => k.done).length}/${all.length} 完了` : '下位タスク';
  host.append(head);

  const kids = sortTasks(all.filter((k) => el.showDone.checked || !k.done));
  if (!kids.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = all.length
      ? '表示できる下位タスクがありません (完了済みは「すべて」画面の「完了も表示」で見られます)。'
      : '下位タスクはまだありません。右上の「＋ 下位タスク」または n キーで追加できます。';
    host.append(p);
    return;
  }
  for (const k of kids) host.append(renderCard(k));
}

/* ---------------- tree ---------------- */

function treeNode(t, lv) {
  const n = document.createElement('div');
  n.className = `tree-node lv${lv}` + (t.done ? ' done' : '');
  const b = document.createElement('span');
  b.className = `tier tier-${t.tier}`;
  b.textContent = TIER_LABEL[t.tier];
  const s = document.createElement('span');
  s.className = 't';
  s.textContent = t.body;
  n.append(b, s);
  n.classList.add('is-linked');
  n.addEventListener('click', () => openDetail(t.id));
  const di = dueInfo(t.due);
  if (di) {
    const d = document.createElement('span');
    d.className = `card-due ${di.cls}`;
    d.style.fontSize = '12px';
    d.textContent = di.label;
    n.append(d);
  }
  return n;
}

function renderTree(list) {
  const wrap = document.createElement('div');
  wrap.className = 'tree';
  const byTier = (x) => list.filter((t) => t.tier === x);
  const kidsOf = (id, t) => list.filter((x) => x.parent_id === id && x.tier === t);

  for (const lg of sortTasks(byTier('long'))) {
    const g = document.createElement('div');
    g.className = 'tree-group';
    g.append(treeNode(lg, 0));
    const sub = document.createElement('div');
    sub.className = 'tree-sub';
    for (const md of sortTasks(kidsOf(lg.id, 'mid'))) {
      sub.append(treeNode(md, 1));
      for (const sh of sortTasks(kidsOf(md.id, 'short'))) sub.append(treeNode(sh, 2));
    }
    for (const sh of sortTasks(kidsOf(lg.id, 'short'))) sub.append(treeNode(sh, 1));
    if (sub.childElementCount) g.append(sub);
    wrap.append(g);
  }

  const orphans = list.filter((t) => t.tier !== 'long' && !t.parent_id);
  const orphanMid = sortTasks(orphans.filter((t) => t.tier === 'mid'));
  const orphanShort = sortTasks(orphans.filter((t) => t.tier === 'short'));
  if (orphanMid.length || orphanShort.length) {
    const g = document.createElement('div');
    g.className = 'tree-group';
    const h = document.createElement('div');
    h.className = 'tree-node lv0';
    h.style.color = 'var(--text-dim)';
    h.textContent = '未分類 (上位タスクなし)';
    g.append(h);
    const sub = document.createElement('div');
    sub.className = 'tree-sub';
    for (const md of orphanMid) {
      sub.append(treeNode(md, 1));
      for (const sh of sortTasks(list.filter((x) => x.parent_id === md.id && x.tier === 'short'))) sub.append(treeNode(sh, 2));
    }
    for (const sh of orphanShort) sub.append(treeNode(sh, 1));
    g.append(sub);
    wrap.append(g);
  }
  return wrap;
}

/* ---------------- render ---------------- */

function render() {
  const list = visible();

  let shown;
  if (view === 'all' || view === 'tree') shown = list;
  else shown = list.filter((t) => t.tier === view);

  el.timeline.replaceChildren();
  if (view === 'tree') {
    el.timeline.append(renderTree(list));
  } else {
    for (const t of sortTasks(shown)) el.timeline.append(renderCard(t));
  }
  el.empty.hidden = shown.length > 0;

  const open = store.all().filter((t) => !t.done);
  el.stat.textContent = `未完了 ${open.length} / 全 ${store.all().length}`;

  const r = parseRoute();
  if (r.name === 'detail') renderDetail(r.id);

  refreshParentOptions();
}

function renderStatus() {
  const s = sync.status;
  const b = el.badge;
  b.className = 'badge';
  if (!s.configured) { b.textContent = 'この端末のみ'; b.title = 'Supabase 未設定'; }
  else if (!s.signedIn) { b.textContent = '未ログイン'; b.classList.add('warn'); }
  else if (s.syncing) { b.textContent = '同期中…'; }
  else if (s.error) { b.textContent = '同期エラー'; b.classList.add('err'); b.title = s.error; }
  else { b.textContent = '同期中 ✓'; b.classList.add('ok'); b.title = s.lastSyncAt ? '最終同期 ' + new Date(s.lastSyncAt).toLocaleString('ja-JP') : ''; }

  el.avatar.textContent = s.email ? s.email[0] : '?';

  $('authState').textContent = !s.configured
    ? 'Supabase 未設定です。上の URL と key を保存してください。'
    : s.signedIn ? `ログイン中: ${s.email}` : 'メールアドレスとパスワードでログインします。初回は「新規登録」から。';
  $('authForm').hidden = s.signedIn;
  $('authSignedIn').hidden = !s.signedIn;
}

/* ---------------- 画面遷移 ---------------- */

/* 一覧 (#) / 詳細 (#t/<id>) / 投稿 (#new, #new?p=<親id>) をハッシュで切り替える。
   pushState の state.d に深さを持たせ、戻るで一段ずつ遡れるようにする。 */

function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h === 'new' || h.startsWith('new?')) {
    return { name: 'compose', parentId: new URLSearchParams(h.split('?')[1] ?? '').get('p') };
  }
  const m = h.match(/^t\/(.+)$/);
  if (m) return { name: 'detail', id: m[1] };
  return { name: 'list' };
}

function depth() {
  return history.state?.d ?? 0;
}

function navigate(hash) {
  history.pushState({ d: depth() + 1 }, '', hash);
  applyRoute(true);
}

/** 一段戻る。アプリが積んだ履歴が無ければ一覧へ。 */
function goBack() {
  if (depth() > 0) history.back();            // popstate で applyRoute が走る
  else {
    history.replaceState({ d: 0 }, '', location.pathname + location.search);
    applyRoute(true);
  }
}

let lastHash = null;

function applyRoute(force = false) {
  if (!force && location.hash === lastHash) return;
  lastHash = location.hash;

  const r = parseRoute();
  el.screenList.hidden = r.name !== 'list';
  el.screenDetail.hidden = r.name !== 'detail';
  el.screenCompose.hidden = r.name !== 'compose';
  for (const [scr, on] of [[el.screenList, r.name === 'list'], [el.screenDetail, r.name === 'detail'], [el.screenCompose, r.name === 'compose']]) {
    scr.setAttribute('aria-hidden', String(!on));
  }
  window.scrollTo({ top: 0 });

  if (r.name === 'detail') renderDetail(r.id);

  if (r.name === 'compose') {
    const parent = r.parentId ? store.byId(r.parentId) : null;
    composeParentId = parent?.id ?? null;
    if (parent) {
      setTier(store.childTiers(parent.tier)[0] ?? tier);   // 長期 → 中期 / 中期 → 短期
      $('composeTitle').textContent = '下位タスクを追加';
    } else {
      $('composeTitle').textContent = '新しいタスク';
      refreshParentOptions();
    }
    autoGrow();
    updateCounter();
    el.text.focus({ preventScroll: true });
  }
}

function openCompose(parentId = null) {
  if (parseRoute().name === 'compose') return;
  navigate(parentId ? `#new?p=${encodeURIComponent(parentId)}` : '#new');
}

function openDetail(id) {
  navigate(`#t/${encodeURIComponent(id)}`);
}

/* ---------------- sheet ---------------- */

function openSheet() {
  const cfg = sync.getConfig();
  $('cfgUrl').value = cfg?.url ?? '';
  $('cfgKey').value = cfg?.key ?? '';
  el.sheet.hidden = false;
  el.backdrop.hidden = false;
}
function closeSheet() {
  el.sheet.hidden = true;
  el.backdrop.hidden = true;
}

/* ---------------- events ---------------- */

el.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  if (parseRoute().name !== 'list') goBack();   // 保険: 一覧タブは常に一覧を見せる
  view = btn.dataset.view;
  for (const t of el.tabs.querySelectorAll('.tab')) t.classList.toggle('is-active', t === btn);
  editingId = null;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-choice]');
  if (b) setTheme(b.dataset.themeChoice);
});
darkMQ.addEventListener('change', () => { if (getTheme() === 'auto') applyTheme('auto'); });

$('btnNew').addEventListener('click', openCompose);
$('btnBack').addEventListener('click', goBack);
$('btnDetailBack').addEventListener('click', goBack);
$('btnAddChild').addEventListener('click', () => {
  const r = parseRoute();
  if (r.name === 'detail') openCompose(r.id);
});
window.addEventListener('popstate', () => applyRoute(true));
window.addEventListener('hashchange', () => applyRoute());

for (const c of el.chips) c.addEventListener('click', () => setTier(c.dataset.tier));

el.parent.addEventListener('change', () => { composeParentId = el.parent.value || null; });

el.text.addEventListener('input', () => { autoGrow(); updateCounter(); });
el.text.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); post(); }
});
el.post.addEventListener('click', post);
el.showDone.addEventListener('change', render);

$('btnSettings').addEventListener('click', openSheet);
$('btnCloseSheet').addEventListener('click', closeSheet);
el.backdrop.addEventListener('click', closeSheet);

$('btnSaveCfg').addEventListener('click', async () => {
  const url = $('cfgUrl').value.trim();
  const key = $('cfgKey').value.trim();
  if (!url || !key) { toast('URL と key の両方が必要です'); return; }
  sync.saveConfig(url, key);
  toast('接続しています…');
  const ok = await sync.init();
  toast(ok ? '接続しました' : '接続できませんでした');
});

$('btnClearCfg').addEventListener('click', () => {
  if (!confirm('Supabase の接続設定を削除します。ローカルのタスクは残ります。')) return;
  sync.clearConfig();
  toast('設定を削除しました');
});

/* Supabase からのエラーは英語なので、よくあるものだけ日本語にする */
function authError(e) {
  const m = String(e?.message ?? e);
  if (/Invalid login credentials/i.test(m)) return 'メールアドレスかパスワードが違います。';
  if (/Email not confirmed/i.test(m)) return 'メールの確認が終わっていません。届いたリンクを開いてください。';
  if (/Password should be at least/i.test(m)) return 'パスワードが短すぎます (既定では 6 文字以上)。';
  if (/User already registered/i.test(m)) return 'このメールアドレスは登録済みです。「ログイン」を押してください。';
  if (/rate limit|too many requests/i.test(m)) return '試行が多すぎます。少し時間をおいてください。';
  if (/not authorized|signups? not allowed|disabled/i.test(m)) return '新規登録が無効になっています (Supabase の設定を確認してください)。';
  return 'エラー: ' + m;
}

function authInput() {
  const email = $('authEmail').value.trim();
  const password = $('authPass').value;
  if (!email || !password) {
    $('authMsg').textContent = 'メールアドレスとパスワードを入力してください。';
    return null;
  }
  return { email, password };
}

$('btnLogin').addEventListener('click', async () => {
  const v = authInput();
  if (!v) return;
  $('authMsg').textContent = 'ログインしています…';
  try {
    await sync.signInWithPassword(v.email, v.password);
    $('authPass').value = '';
    $('authMsg').textContent = '';
    toast('ログインしました');
  } catch (e) {
    $('authMsg').textContent = authError(e);
  }
});

$('btnSignup').addEventListener('click', async () => {
  const v = authInput();
  if (!v) return;
  $('authMsg').textContent = '登録しています…';
  try {
    const signedIn = await sync.signUp(v.email, v.password);
    $('authPass').value = '';
    if (signedIn) {
      $('authMsg').textContent = '';
      toast('登録してログインしました');
    } else {
      $('authMsg').textContent = '確認メールを送りました。リンクを開くとログインできます。';
    }
  } catch (e) {
    $('authMsg').textContent = authError(e);
  }
});

$('btnReset').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  if (!email) { $('authMsg').textContent = 'メールアドレスを入力してください。'; return; }
  try {
    await sync.sendPasswordReset(email);
    $('authMsg').textContent = '再設定メールを送りました。リンクを開くとログイン状態になるので、下の「パスワードを変更」で設定し直してください。';
  } catch (e) {
    $('authMsg').textContent = authError(e);
  }
});

$('btnChangePass').addEventListener('click', async () => {
  const pw = $('newPass').value;
  if (!pw) { $('authMsg').textContent = '新しいパスワードを入力してください。'; return; }
  try {
    await sync.updatePassword(pw);
    $('newPass').value = '';
    $('authMsg').textContent = '';
    toast('パスワードを変更しました');
  } catch (e) {
    $('authMsg').textContent = authError(e);
  }
});

$('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnLogin').click(); });
$('newPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnChangePass').click(); });

$('btnLogout').addEventListener('click', async () => {
  await sync.signOut();
  $('authMsg').textContent = '';
  toast('ログアウトしました');
});

$('btnSync').addEventListener('click', async () => {
  const ok = await sync.syncNow();
  $('dataMsg').textContent = ok ? '同期しました。' : (sync.status.configured ? (sync.status.error ?? 'ログインが必要です。') : 'Supabase が未設定です。');
});

$('btnExport').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tasks-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const n = store.importJSON(await f.text());
    $('dataMsg').textContent = `${n} 件読み込みました。`;
    sync.syncNow().catch(() => {});
  } catch (err) {
    $('dataMsg').textContent = '読み込み失敗: ' + (err.message ?? err);
  }
  e.target.value = '';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) closeSheet();
    else if (parseRoute().name !== 'list') goBack();
    return;
  }

  // n / c で投稿画面へ。入力中・修飾キー併用・設定シート表示中は無効。
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!el.sheet.hidden) return;
  const tag = e.target.tagName;
  if (e.target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'n' || e.key === 'N' || e.key === 'c' || e.key === 'C') {
    const r = parseRoute();
    if (r.name === 'compose') return;
    e.preventDefault();
    // 詳細画面からなら、その下位タスクとして開く
    const parent = r.name === 'detail' ? store.byId(r.id) : null;
    openCompose(parent && store.childTiers(parent.tier).length ? parent.id : null);
  }
});

window.addEventListener('online', () => sync.syncNow().catch(() => {}));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync.syncNow().catch(() => {});
});

/* ---------------- boot ---------------- */

store.subscribe(render);
sync.onStatus(renderStatus);

applyTheme(getTheme());
el.due.min = '2000-01-01';
setTier('short');
updateCounter();
autoGrow();
render();
renderStatus();
applyRoute();
sync.init().catch(console.warn);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  });
}
