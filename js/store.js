// Хранилище: Supabase (если настроен) или localStorage (демо-режим).
import { CONFIG } from './config.js';

const LS_SUBS = 'podpiski.subs';
const LS_CACHE = 'podpiski.cache';

const ls = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const FIELDS = ['service_id', 'name', 'domain', 'plan', 'price', 'currency', 'period_unit', 'period_count',
  'start_date', 'category', 'remind_days', 'notes', 'active'];

function pick(sub) {
  const o = {};
  for (const f of FIELDS) if (sub[f] !== undefined) o[f] = sub[f];
  return o;
}

export const isCloud = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

let sb = null;

export async function init() {
  if (!isCloud) return;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

export async function getUser() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

export function onAuthChange(cb) {
  if (sb) sb.auth.onAuthStateChange((_e, session) => cb(session?.user ?? null));
}

const AUTH_ERRORS = {
  'Invalid login credentials': 'Неверный email или пароль',
  'User already registered': 'Такой аккаунт уже есть — войди',
  'Email not confirmed': 'Email не подтверждён: отключи «Confirm email» в Supabase (README, шаг 2)',
};
function authError(error) {
  return new Error(AUTH_ERRORS[error.message] || error.message);
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw authError(error);
}

export async function signUp(email, password) {
  const { error } = await sb.auth.signUp({ email, password });
  if (error) throw authError(error);
}

export async function signOut() {
  if (sb) await sb.auth.signOut();
  ls.set(LS_CACHE, []);
}

// Последний загруженный список — чтобы приложение открывалось мгновенно и без сети
export function cached() {
  return isCloud ? ls.get(LS_CACHE, []) : ls.get(LS_SUBS, []);
}

export async function list() {
  if (!sb) return ls.get(LS_SUBS, []);
  const { data, error } = await sb.from('subscriptions').select('*').order('created_at');
  if (error) throw error;
  ls.set(LS_CACHE, data);
  return data;
}

export async function save(sub) {
  const row = pick(sub);
  if (!sb) {
    const all = ls.get(LS_SUBS, []);
    if (sub.id) {
      const i = all.findIndex((s) => s.id === sub.id);
      all[i] = { ...all[i], ...row };
    } else {
      all.push({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() });
    }
    ls.set(LS_SUBS, all);
    return;
  }
  const q = sub.id
    ? sb.from('subscriptions').update(row).eq('id', sub.id)
    : sb.from('subscriptions').insert(row);
  const { error } = await q;
  if (error) throw error;
}

export async function remove(id) {
  if (!sb) {
    ls.set(LS_SUBS, ls.get(LS_SUBS, []).filter((s) => s.id !== id));
    return;
  }
  const { error } = await sb.from('subscriptions').delete().eq('id', id);
  if (error) throw error;
}

export async function importMany(rows) {
  if (!sb) {
    const all = ls.get(LS_SUBS, []);
    for (const r of rows) all.push({ ...pick(r), id: crypto.randomUUID(), created_at: new Date().toISOString() });
    ls.set(LS_SUBS, all);
    return;
  }
  const { error } = await sb.from('subscriptions').insert(rows.map(pick));
  if (error) throw error;
}

export async function registerPush(subscription) {
  const j = subscription.toJSON();
  const { error } = await sb.rpc('register_push', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent,
  });
  if (error) throw error;
}

export async function unregisterPush(endpoint) {
  if (sb) await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
