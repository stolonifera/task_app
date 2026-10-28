/* Supabase 同期レイヤ。
   ローカルの 1 レコードを tier ごとに別テーブル (tasks_short / tasks_mid / tasks_long)
   へ振り分ける。親参照は上位テーブルへの FK。 */

import * as store from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const CFG_KEY = 'taskapp.cfg';

const TABLE = { short: 'tasks_short', mid: 'tasks_mid', long: 'tasks_long' };
const PUSH_ORDER = ['long', 'mid', 'short']; // FK 順
const COLS = 'id,body,due,done,created_at,updated_at,deleted';

let client = null;
let session = null;
let channel = null;
const listeners = new Set();

export const status = { configured: false, signedIn: false, email: null, syncing: false, error: null, lastSyncAt: null };

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn(status);
}

/* ---------- 設定 ---------- */

export function getConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c?.url && c?.key) return c;
    }
  } catch { /* noop */ }
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
  return null;
}

export function saveConfig(url, key) {
  localStorage.setItem(CFG_KEY, JSON.stringify({ url: url.trim().replace(/\/+$/, ''), key: key.trim() }));
}

export function clearConfig() {
  localStorage.removeItem(CFG_KEY);
  client = null;
  session = null;
  status.configured = false;
  status.signedIn = false;
  status.email = null;
  emit();
}

/* ---------- 接続 ---------- */

export async function init() {
  const cfg = getConfig();
  if (!cfg) {
    status.configured = false;
    emit();
    return false;
  }
  try {
    unsubscribeRealtime();           // 再接続時に古い購読を残さない
    const { createClient } = await import(/* @vite-ignore */ SDK);
    client = createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    status.configured = true;
    status.error = null;

    const { data } = await client.auth.getSession();
    applySession(data.session);

    client.auth.onAuthStateChange((_evt, s) => {
      applySession(s);
      if (s) syncNow().catch(console.warn);
    });

    if (session) await syncNow();
    return true;
  } catch (e) {
    console.warn('Supabase 初期化に失敗', e);
    status.configured = false;
    status.error = 'SDK を読み込めませんでした (オフライン?)';
    emit();
    return false;
  }
}

function applySession(s) {
  session = s || null;
  status.signedIn = !!session;
  status.email = session?.user?.email ?? null;
  emit();
  if (session) subscribeRealtime();
  else unsubscribeRealtime();
}

const redirectUrl = () => location.origin + location.pathname;

export async function signInWithPassword(email, password) {
  if (!client) throw new Error('Supabase が未設定です');
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** @returns {boolean} true ならそのままログイン済み (確認メール不要の設定) */
export async function signUp(email, password) {
  if (!client) throw new Error('Supabase が未設定です');
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl() },
  });
  if (error) throw error;
  return !!data.session;
}

/** 再設定メールのリンクを開くとこのアプリに戻り、セッションが張られた状態になる */
export async function sendPasswordReset(email) {
  if (!client) throw new Error('Supabase が未設定です');
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
  if (error) throw error;
}

export async function updatePassword(password) {
  if (!client) throw new Error('Supabase が未設定です');
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  if (!client) return;
  await client.auth.signOut();
  applySession(null);
}

/* ---------- 変換 ---------- */

function toRow(t) {
  const row = {
    id: t.id,
    body: t.body,
    due: t.due,
    done: t.done,
    created_at: t.created_at,
    updated_at: t.updated_at,
    deleted: t.deleted,
    user_id: session.user.id,
  };
  if (t.tier === 'mid') {
    row.long_id = t.parent_tier === 'long' ? t.parent_id : null;
  } else if (t.tier === 'short') {
    row.mid_id = t.parent_tier === 'mid' ? t.parent_id : null;
    row.long_id = t.parent_tier === 'long' ? t.parent_id : null;
  }
  return row;
}

function fromRow(tier, r) {
  let parent_tier = null;
  let parent_id = null;
  if (tier === 'mid' && r.long_id) {
    parent_tier = 'long';
    parent_id = r.long_id;
  } else if (tier === 'short') {
    if (r.mid_id) { parent_tier = 'mid'; parent_id = r.mid_id; }
    else if (r.long_id) { parent_tier = 'long'; parent_id = r.long_id; }
  }
  return {
    id: r.id,
    tier,
    body: r.body ?? '',
    parent_tier,
    parent_id,
    due: r.due ?? null,
    done: !!r.done,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted,
  };
}

function selectCols(tier) {
  if (tier === 'long') return COLS;
  if (tier === 'mid') return COLS + ',long_id';
  return COLS + ',mid_id,long_id';
}

/* ---------- 同期 ---------- */

export async function syncNow() {
  if (!client || !session || status.syncing) return false;
  status.syncing = true;
  status.error = null;
  emit();
  try {
    await push();
    await pull();
    status.lastSyncAt = new Date().toISOString();
    return true;
  } catch (e) {
    console.warn('同期に失敗', e);
    status.error = e?.message ?? String(e);
    return false;
  } finally {
    status.syncing = false;
    emit();
  }
}

async function push() {
  const dirty = store.dirtyTasks();
  if (!dirty.length) return;
  for (const tier of PUSH_ORDER) {
    const rows = dirty.filter((t) => t.tier === tier).map(toRow);
    if (!rows.length) continue;
    const { error } = await client.from(TABLE[tier]).upsert(rows, { onConflict: 'id' });
    if (error) throw error;
    store.markClean(rows.map((r) => r.id));
  }
}

async function pull() {
  const since = store.pulledAt();
  const merged = [];
  let newest = since;
  for (const tier of PUSH_ORDER) {
    let q = client.from(TABLE[tier]).select(selectCols(tier));
    if (since) q = q.gt('updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data ?? []) {
      merged.push(fromRow(tier, r));
      if (!newest || r.updated_at > newest) newest = r.updated_at;
    }
  }
  if (merged.length) store.mergeRemote(merged);
  if (newest) store.setPulledAt(newest);
}

/* ---------- リアルタイム ---------- */

function subscribeRealtime() {
  if (!client || channel) return;
  channel = client.channel('taskapp-sync');
  for (const tier of PUSH_ORDER) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table: TABLE[tier] }, (payload) => {
      const r = payload.new;
      if (!r?.id) return;
      store.mergeRemote([fromRow(tier, r)]);
    });
  }
  channel.subscribe();
}

function unsubscribeRealtime() {
  if (channel) {
    client?.removeChannel(channel);
    channel = null;
  }
}
