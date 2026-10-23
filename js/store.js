/* ローカルストア: localStorage を正本のキャッシュとして持ち、
   dirty フラグの付いたレコードを Supabase に押し出す。 */

const KEY = 'taskapp.v1';
const TIERS = ['short', 'mid', 'long'];

export const TIER_LABEL = { short: '短期', mid: '中期', long: '長期' };
export const TIER_ORDER = { long: 0, mid: 1, short: 2 };

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // 保険 (古い環境 / http 経由)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function emptyState() {
  return { tasks: {}, pulledAt: null, deviceId: uuid() };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || typeof s.tasks !== 'object') return emptyState();
    s.tasks ??= {};
    s.deviceId ??= uuid();
    return s;
  } catch {
    return emptyState();
  }
}

let state = load();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('localStorage への保存に失敗', e);
  }
}

function emit() {
  persist();
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDeviceId() {
  return state.deviceId;
}

export function pulledAt() {
  return state.pulledAt;
}

export function setPulledAt(iso) {
  state.pulledAt = iso;
  persist();
}

/** 表示用: 削除済みを除いた配列 */
export function all() {
  return Object.values(state.tasks).filter((t) => !t.deleted);
}

export function byId(id) {
  const t = state.tasks[id];
  return t && !t.deleted ? t : null;
}

/** tier の 1 つ上 / 2 つ上の枠 */
export function parentTiers(tier) {
  if (tier === 'short') return ['mid', 'long'];
  if (tier === 'mid') return ['long'];
  return [];
}

export function create({ tier, text, parentId = null, parentTier = null, due = null }) {
  if (!TIERS.includes(tier)) throw new Error('unknown tier: ' + tier);
  const now = new Date().toISOString();
  const task = {
    id: uuid(),
    tier,
    body: text.trim(),
    parent_tier: parentId ? parentTier : null,
    parent_id: parentId || null,
    due: due || null,
    done: false,
    created_at: now,
    updated_at: now,
    deleted: false,
    dirty: true,
  };
  state.tasks[task.id] = task;
  emit();
  return task;
}

export function update(id, patch) {
  const t = state.tasks[id];
  if (!t) return null;
  Object.assign(t, patch, { updated_at: new Date().toISOString(), dirty: true });
  emit();
  return t;
}

export function toggleDone(id) {
  const t = state.tasks[id];
  if (!t) return;
  update(id, { done: !t.done });
}

/** 論理削除。子タスクは親参照だけ外して残す。 */
export function remove(id) {
  const t = state.tasks[id];
  if (!t) return;
  for (const c of Object.values(state.tasks)) {
    if (c.parent_id === id) {
      Object.assign(c, { parent_id: null, parent_tier: null, updated_at: new Date().toISOString(), dirty: true });
    }
  }
  update(id, { deleted: true });
}

export function children(parentId) {
  return all().filter((t) => t.parent_id === parentId);
}

/* ---------- 同期用 ---------- */

export function dirtyTasks() {
  return Object.values(state.tasks).filter((t) => t.dirty);
}

export function markClean(ids) {
  for (const id of ids) if (state.tasks[id]) state.tasks[id].dirty = false;
  persist();
}

/** リモート行をマージ (updated_at が新しい側を採用) */
export function mergeRemote(rows) {
  let changed = 0;
  for (const r of rows) {
    const local = state.tasks[r.id];
    if (!local) {
      state.tasks[r.id] = { ...r, dirty: false };
      changed++;
      continue;
    }
    if (local.dirty && local.updated_at >= r.updated_at) continue; // ローカルが新しい
    if (local.updated_at < r.updated_at) {
      state.tasks[r.id] = { ...r, dirty: false };
      changed++;
    }
  }
  if (changed) emit();
  return changed;
}

export function exportJSON() {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks: all() }, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : data.tasks;
  if (!Array.isArray(rows)) throw new Error('tasks 配列が見つかりません');
  let n = 0;
  for (const r of rows) {
    if (!r?.id || !TIERS.includes(r.tier)) continue;
    state.tasks[r.id] = {
      id: r.id,
      tier: r.tier,
      body: String(r.body ?? r.text ?? ''),
      parent_tier: r.parent_tier ?? null,
      parent_id: r.parent_id ?? null,
      due: r.due ?? null,
      done: !!r.done,
      created_at: r.created_at ?? new Date().toISOString(),
      updated_at: r.updated_at ?? new Date().toISOString(),
      deleted: !!r.deleted,
      dirty: true,
    };
    n++;
  }
  emit();
  return n;
}

export function wipeLocal() {
  state = emptyState();
  emit();
}
