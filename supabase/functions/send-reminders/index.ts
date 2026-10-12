// Supabase Edge Function: раз в день рассылает push-напоминания о ближайших списаниях.
// Без внешних зависимостей: Web Push (RFC 8291 + VAPID) реализован на встроенном WebCrypto,
// к базе обращаемся через REST API.
//
// Секреты функции (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:почта), CRON_SECRET
//   TIME_ZONE — необязательно, по умолчанию Europe/Moscow
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
//
// Тело запроса: {} — обычный запуск; {"test": true} — тестовый push на все устройства;
//               {"dry": true} — ничего не отправлять, вернуть план.

// ======================================================================
// Расчёт дат (копия js/dates.js — при изменении обнови оба места)
// ======================================================================
const DAY = 86400000;
function toDate(s: string) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function toISO(dt: Date) { return dt.toISOString().slice(0, 10); }
function todayISO(timeZone = 'Europe/Moscow') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function daysBetween(a: string, b: string) { return Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY); }
function daysInMonth(y: number, m: number) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
function nthPayment(start: string, unit: string, count: number, k: number) {
  const a = toDate(start);
  if (unit === 'day' || unit === 'week') {
    const step = (unit === 'day' ? 1 : 7) * count;
    return toISO(new Date(a.getTime() + k * step * DAY));
  }
  const months = (unit === 'year' ? 12 : 1) * count * k;
  const total = a.getUTCMonth() + months;
  const y = a.getUTCFullYear() + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  return toISO(new Date(Date.UTC(y, mo, Math.min(a.getUTCDate(), daysInMonth(y, mo)))));
}
function approxDays(unit: string, count: number) {
  return ({ day: 1, week: 7, month: 30.436875, year: 365.2425 } as Record<string, number>)[unit] * count;
}
function nextPayment(start: string, unit: string, count: number, today: string) {
  const diff = daysBetween(start, today);
  if (diff <= 0) return start;
  let k = Math.max(0, Math.floor(diff / approxDays(unit, count)) - 1);
  let d = nthPayment(start, unit, count, k);
  while (d < today) { k += 1; d = nthPayment(start, unit, count, k); }
  return d;
}

// ======================================================================
// Web Push на WebCrypto
// ======================================================================
const enc = new TextEncoder();
function b64uDecode(s: string) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function b64uEncode(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

let vapidKey: CryptoKey | null = null;
async function vapidJWT(endpoint: string, publicKey: string, privateKey: string, subject: string) {
  if (!vapidKey) {
    const pub = b64uDecode(publicKey);
    vapidKey = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: privateKey,
      x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true,
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64uEncode(sig)}`;
}

// Шифрование содержимого по RFC 8291 (aes128gcm)
async function encryptPayload(p256dh: string, authSecret: string, payload: string) {
  const uaPub = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

async function sendPush(dev: Device, payload: string) {
  const jwt = await vapidJWT(dev.endpoint, env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'), env('VAPID_SUBJECT') || 'mailto:admin@example.com');
  const body = await encryptPayload(dev.p256dh, dev.auth, payload);
  const res = await fetch(dev.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${env('VAPID_PUBLIC_KEY')}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(12 * 3600),
      Urgency: 'normal',
    },
    body,
  });
  if (!res.ok) {
    const err = new Error(`push ${res.status}: ${await res.text().catch(() => '')}`) as Error & { statusCode?: number };
    err.statusCode = res.status;
    throw err;
  }
}

// ======================================================================
// База через REST (service role обходит RLS)
// ======================================================================
type Sub = {
  id: string; user_id: string; name: string; plan: string | null; price: number; currency: string;
  period_unit: string; period_count: number; start_date: string; remind_days: number;
};
type Device = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

const env = (k: string) => Deno.env.get(k) ?? '';

async function db(path: string, init: RequestInit = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  return res.status === 204 || init.method === 'DELETE' || init.method === 'POST' ? null : res.json();
}
const inList = (ids: string[]) => `in.(${ids.map((x) => `"${x}"`).join(',')})`;

// ======================================================================
// Тексты
// ======================================================================
function money(v: number, cur: string) {
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
  } catch {
    return `${v} ${cur}`;
  }
}
const dShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
function when(days: number) {
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'завтра';
  if (days === 2) return 'послезавтра';
  const a = days % 100, b = days % 10;
  const w = a > 10 && a < 20 ? 'дней' : b === 1 ? 'день' : b > 1 && b < 5 ? 'дня' : 'дней';
  return `через ${days} ${w}`;
}

// ======================================================================
// Обработчик
// ======================================================================
Deno.serve(async (req) => {
  if (!env('CRON_SECRET') || req.headers.get('x-cron-secret') !== env('CRON_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const today = todayISO(env('TIME_ZONE') || 'Europe/Moscow');
    type Msg = { title: string; body: string; tag: string; log: { subscription_id: string; payment_date: string }[] };
    const messages = new Map<string, Msg>();

    if (body.test) {
      const devs: { user_id: string }[] = await db('push_subscriptions?select=user_id');
      for (const d of devs) messages.set(d.user_id, { title: 'Подписки', body: 'Тестовое уведомление с сервера — всё работает 🦀', tag: 'test', log: [] });
    } else {
      const subs: Sub[] = await db('subscriptions?select=*&active=eq.true');
      const due = subs
        .map((s) => {
          const next = nextPayment(s.start_date, s.period_unit, Number(s.period_count) || 1, today);
          return { ...s, next, days: daysBetween(today, next) };
        })
        .filter((s) => s.days <= s.remind_days);

      const logs: { subscription_id: string; payment_date: string }[] = due.length
        ? await db(`reminder_log?select=subscription_id,payment_date&subscription_id=${inList(due.map((s) => s.id))}`)
        : [];
      const sent = new Set(logs.map((l) => `${l.subscription_id}|${l.payment_date}`));
      const fresh = due.filter((s) => !sent.has(`${s.id}|${s.next}`)).sort((a, b) => a.days - b.days);

      const byUser = new Map<string, typeof fresh>();
      for (const s of fresh) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);

      for (const [uid, list] of byUser) {
        const log = list.map((s) => ({ subscription_id: s.id, payment_date: s.next }));
        if (list.length === 1) {
          const s = list[0];
          messages.set(uid, {
            title: `${s.name} — ${when(s.days)}`,
            body: `Спишется ${money(Number(s.price), s.currency)}${s.plan ? ` · ${s.plan}` : ''} · ${dShort.format(toDate(s.next))}`,
            tag: `remind-${s.id}-${s.next}`,
            log,
          });
        } else {
          messages.set(uid, {
            title: `Скоро списания: ${list.length}`,
            body: list.map((s) => `${s.name} — ${money(Number(s.price), s.currency)}, ${when(s.days)}`).join('\n'),
            tag: `remind-${today}`,
            log,
          });
        }
      }
    }

    if (body.dry) return Response.json({ today, messages: Object.fromEntries(messages) });
    if (!messages.size) return Response.json({ today, sent: 0 });

    const devices: Device[] = await db(`push_subscriptions?select=*&user_id=${inList([...messages.keys()])}`);
    let ok = 0;
    const gone: string[] = [];
    const errors: string[] = [];
    const delivered = new Set<string>();

    await Promise.all(devices.map(async (d) => {
      const m = messages.get(d.user_id)!;
      try {
        await sendPush(d, JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: './' }));
        ok++;
        delivered.add(d.user_id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(d.id); // устройство отписалось
        else errors.push((e as Error).message);
      }
    }));

    if (gone.length) await db(`push_subscriptions?id=${inList(gone)}`, { method: 'DELETE' });

    const log = [...messages].filter(([uid]) => delivered.has(uid)).flatMap(([, m]) => m.log);
    if (log.length) {
      await db('reminder_log?on_conflict=subscription_id,payment_date', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(log),
      });
    }

    return Response.json({ today, users: messages.size, devices: devices.length, pushed: ok, removed_devices: gone.length, errors });
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
