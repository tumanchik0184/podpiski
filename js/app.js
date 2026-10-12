import { CONFIG } from './config.js';
import { CATALOG, CATEGORIES, CURRENCIES } from './catalog.js';
import * as store from './store.js';
import { initRates, convert, ratesApproximate } from './rates.js';
import {
  todayISO, nextPayment, daysBetween, paymentsBetween, monthlyCost, toDate,
} from './dates.js';

// ---------------------------------------------------------------- состояние
const S = {
  subs: [],
  user: undefined, // undefined — ещё не знаем, null — не вошёл
  view: 'list',
  month: todayISO(CONFIG.TIME_ZONE).slice(0, 7),
  selDay: null,
  mainCur: lsGet('podpiski.currency', 'RUB'),
  showPaused: false,
  loginEmail: '',
  loginStep: 'signin', // 'signin' | 'signup'
};

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const sheet = $('#sheet');

function lsGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
const today = () => todayISO(CONFIG.TIME_ZONE);

// ---------------------------------------------------------------- форматирование
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(v, cur, exact = false) {
  if (!Number.isFinite(v)) return '—';
  const frac = exact ? (Math.round(v * 100) % 100 ? 2 : 0) : (Math.abs(v) < 100 && v % 1 ? 2 : 0);
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur, minimumFractionDigits: frac, maximumFractionDigits: frac }).format(v);
  } catch {
    return `${v.toFixed(frac)} ${cur}`;
  }
}

const dShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' });
const dMonth = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtShort = (iso) => dShort.format(toDate(iso)).replace('.', '');

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function relDays(n) {
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n === 2) return 'послезавтра';
  return `через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

const UNIT = {
  day:   ['день', 'дня', 'дней', 'в день'],
  week:  ['неделю', 'недели', 'недель', 'в неделю'],
  month: ['месяц', 'месяца', 'месяцев', 'в месяц'],
  year:  ['год', 'года', 'лет', 'в год'],
};
function periodLabel(unit, count) {
  if (count === 1) return UNIT[unit][3];
  const [one, few, many] = UNIT[unit];
  return `за ${count} ${plural(count, one, few, many)}`;
}

function remindLabel(n) {
  if (n === 0) return 'в день списания';
  return `за ${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

function logo(sub, size = 40) {
  const name = sub.name || '?';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  const letter = esc(name.trim()[0]?.toUpperCase() || '?');
  const img = sub.domain
    ? `<img class="logo-img" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(sub.domain)}&sz=128" alt="" loading="lazy">`
    : '';
  return `<span class="logo" style="--h:${h};--s:${size}px"><span class="logo-letter">${letter}</span>${img}</span>`;
}
// если логотип не загрузился — остаётся буква
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement && e.target.classList.contains('logo-img')) e.target.remove();
}, true);

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

// ---------------------------------------------------------------- расчёты
function enrich(sub) {
  const t = today();
  const unit = sub.period_unit, count = Number(sub.period_count) || 1;
  const next = nextPayment(sub.start_date, unit, count, t);
  const monthly = convert(monthlyCost(sub.price, unit, count), sub.currency, S.mainCur);
  return { ...sub, period_count: count, next, days: daysBetween(t, next), monthly };
}

function activeSubs() {
  return S.subs.filter((s) => s.active).map(enrich).sort((a, b) => a.days - b.days || b.monthly - a.monthly);
}

// ---------------------------------------------------------------- данные
async function reload() {
  try {
    S.subs = await store.list();
  } catch (e) {
    console.error(e);
    toast('Не удалось загрузить данные');
  }
  render();
}

// ---------------------------------------------------------------- отрисовка
const TABS = [
  ['list', 'Подписки', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
  ['calendar', 'Календарь', '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
  ['stats', 'Траты', '<path d="M5 20V11M12 20V5M19 20v-6"/>'],
  ['settings', 'Настройки', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'],
];

function render() {
  if (store.isCloud && S.user === null) { app.innerHTML = loginView(); return; }
  const body = { list: listView, calendar: calendarView, stats: statsView, settings: settingsView }[S.view]();
  const title = TABS.find((t) => t[0] === S.view)[1];
  app.innerHTML = `
    <header class="top">
      <h1>${title}</h1>
      ${S.view !== 'settings' ? '<button class="btn-add" data-act="add" aria-label="Добавить подписку"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' : ''}
    </header>
    <main>${body}</main>
    <nav class="tabs">
      ${TABS.map(([id, label, icon]) => `
        <button class="tab ${S.view === id ? 'on' : ''}" data-tab="${id}">
          <svg viewBox="0 0 24 24">${icon}</svg><span>${label}</span>
        </button>`).join('')}
    </nav>`;
}

// ---------- список
function listView() {
  const act = activeSubs();
  const paused = S.subs.filter((s) => !s.active);
  if (!S.subs.length) {
    return `<div class="empty">
      <div class="empty-art">🦀</div>
      <h2>Пока пусто</h2>
      <p>Добавь подписки из каталога — приложение посчитает расходы и напомнит о списаниях.</p>
      <button class="btn primary" data-act="add">Добавить подписку</button>
    </div>`;
  }
  const month = act.reduce((a, s) => a + s.monthly, 0);
  const t = today();
  const in30 = act.filter((s) => s.days <= 30).reduce((a, s) => a + convert(Number(s.price), s.currency, S.mainCur), 0);
  const soon = act[0];

  const row = (s) => `
    <button class="sub ${s.days <= s.remind_days ? 'soon' : ''}" data-edit="${s.id}">
      ${logo(s)}
      <span class="sub-main">
        <span class="sub-name">${esc(s.name)}</span>
        <span class="sub-plan">${esc(s.plan || CATEGORIES[s.category]?.label || '')}</span>
      </span>
      <span class="sub-side">
        <span class="sub-price">${money(Number(s.price), s.currency, true)}</span>
        <span class="sub-when">${s.active ? `${relDays(s.days)} · ${fmtShort(s.next)}` : 'на паузе'}</span>
      </span>
    </button>`;

  return `
    <section class="summary">
      <div class="sum-main">
        <span class="label">В месяц</span>
        <span class="big">${money(month, S.mainCur)}</span>
        <span class="sub-label">${money(month * 12, S.mainCur)} в год · ${act.length} ${plural(act.length, 'подписка', 'подписки', 'подписок')}</span>
      </div>
      <div class="sum-side">
        <div><span class="label">За 30 дней спишется</span><b>${money(in30, S.mainCur)}</b></div>
        ${soon ? `<div><span class="label">Ближайшее</span><b>${esc(soon.name)}</b><span class="muted"> ${relDays(soon.days)}</span></div>` : ''}
      </div>
    </section>
    ${act.length ? `<h3 class="sec">По дате списания</h3><div class="card list">${act.map(row).join('')}</div>` : ''}
    ${paused.length ? `
      <button class="sec sec-toggle" data-act="toggle-paused">На паузе (${paused.length}) ${S.showPaused ? '▴' : '▾'}</button>
      ${S.showPaused ? `<div class="card list dim">${paused.map((s) => row({ ...s, days: 99 })).join('')}</div>` : ''}` : ''}
    ${ratesApproximate() && act.some((s) => s.currency !== S.mainCur) ? '<p class="note">Курсы валют примерные — нет связи с ЦБ.</p>' : ''}
    <p class="note">Сегодня ${dLong.format(toDate(t))}</p>`;
}

// ---------- календарь
function calendarView() {
  const [y, m] = S.month.split('-').map(Number);
  const first = `${S.month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${S.month}-${String(lastDay).padStart(2, '0')}`;
  const byDay = {};
  let total = 0;
  for (const s of S.subs.filter((x) => x.active)) {
    const count = Number(s.period_count) || 1;
    for (const d of paymentsBetween(s.start_date, s.period_unit, count, first, last)) {
      (byDay[d] ||= []).push(s);
      total += convert(Number(s.price), s.currency, S.mainCur);
    }
  }
  const offset = (toDate(first).getUTCDay() + 6) % 7; // понедельник — первый
  const t = today();
  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<span class="day blank"></span>';
  for (let d = 1; d <= lastDay; d++) {
    const iso = `${S.month}-${String(d).padStart(2, '0')}`;
    const items = byDay[iso] || [];
    cells += `
      <button class="day ${iso === t ? 'today' : ''} ${iso === S.selDay ? 'sel' : ''} ${items.length ? 'has' : ''}" data-day="${iso}">
        <span class="dnum">${d}</span>
        <span class="dlogos">${items.slice(0, 3).map((s) => logo(s, 18)).join('')}${items.length > 3 ? `<span class="more">+${items.length - 3}</span>` : ''}</span>
      </button>`;
  }
  const sel = S.selDay && S.selDay.startsWith(S.month) ? S.selDay : null;
  const selItems = sel ? byDay[sel] || [] : [];
  const monthName = dMonth.format(toDate(first)).replace(' г.', '');

  return `
    <div class="cal-head">
      <button class="icon-btn" data-month="-1" aria-label="Предыдущий месяц">‹</button>
      <div class="cal-title"><b>${monthName[0].toUpperCase() + monthName.slice(1)}</b><span>${money(total, S.mainCur)}</span></div>
      <button class="icon-btn" data-month="1" aria-label="Следующий месяц">›</button>
    </div>
    <div class="card cal">
      <div class="wd">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="grid">${cells}</div>
    </div>
    ${sel ? `
      <h3 class="sec">${dLong.format(toDate(sel))}</h3>
      ${selItems.length ? `<div class="card list">${selItems.map((s) => `
        <button class="sub" data-edit="${s.id}">${logo(s)}
          <span class="sub-main"><span class="sub-name">${esc(s.name)}</span><span class="sub-plan">${esc(s.plan || '')}</span></span>
          <span class="sub-side"><span class="sub-price">${money(Number(s.price), s.currency, true)}</span></span>
        </button>`).join('')}</div>` : '<p class="note">В этот день списаний нет.</p>'}`
    : '<p class="note">Нажми на день, чтобы увидеть списания.</p>'}`;
}

// ---------- траты
function statsView() {
  const act = activeSubs();
  if (!act.length) return '<p class="note">Добавь подписки, и здесь появится разбивка расходов.</p>';
  const total = act.reduce((a, s) => a + s.monthly, 0);
  const cats = {};
  for (const s of act) {
    const c = s.category && CATEGORIES[s.category] ? s.category : 'other';
    cats[c] = (cats[c] || 0) + s.monthly;
  }
  const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const max = catRows[0][1];
  const top = [...act].sort((a, b) => b.monthly - a.monthly);
  return `
    <section class="summary compact">
      <div class="sum-main">
        <span class="label">В среднем в месяц</span>
        <span class="big">${money(total, S.mainCur)}</span>
        <span class="sub-label">${money(total * 12, S.mainCur)} в год · ${money(total / 30.44, S.mainCur)} в день</span>
      </div>
    </section>
    <h3 class="sec">По категориям</h3>
    <div class="card pad">
      ${catRows.map(([c, v]) => `
        <div class="bar-row">
          <span class="bar-label">${CATEGORIES[c].emoji} ${CATEGORIES[c].label}</span>
          <span class="bar-val">${money(v, S.mainCur)}</span>
          <span class="bar"><span style="width:${Math.max(3, (v / max) * 100)}%"></span></span>
        </div>`).join('')}
    </div>
    <h3 class="sec">Самые дорогие</h3>
    <div class="card list">
      ${top.map((s) => `
        <button class="sub" data-edit="${s.id}">${logo(s)}
          <span class="sub-main"><span class="sub-name">${esc(s.name)}</span>
            <span class="sub-plan">${money(Number(s.price), s.currency, true)} ${periodLabel(s.period_unit, s.period_count)}</span></span>
          <span class="sub-side"><span class="sub-price">${money(s.monthly, S.mainCur)}<small>/мес</small></span>
            <span class="sub-when">${Math.round((s.monthly / total) * 100)}%</span></span>
        </button>`).join('')}
    </div>
    <p class="note">Годовые и недельные подписки пересчитаны в месяц. Валюты — по курсу ЦБ${ratesApproximate() ? ' (примерно)' : ''}.</p>`;
}

// ---------- настройки
function settingsView() {
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';

  let push;
  if (!store.isCloud) push = '<p class="muted">Push работает после подключения Supabase (см. README).</p>';
  else if (!CONFIG.VAPID_PUBLIC_KEY) push = '<p class="muted">Не задан VAPID_PUBLIC_KEY в config.js.</p>';
  else if (isIOS && !standalone) push = '<p class="muted">На iPhone уведомления работают только у приложения на экране «Домой»: Поделиться → «На экран Домой», затем открой его оттуда.</p>';
  else if (!pushOk) push = '<p class="muted">Этот браузер не поддерживает push-уведомления.</p>';
  else if (perm === 'denied') push = '<p class="muted">Уведомления запрещены в настройках браузера/системы для этого сайта.</p>';
  else push = `
    <div class="row-btns">
      <button class="btn primary" data-act="push-on">Включить на этом устройстве</button>
      <button class="btn" data-act="push-test">Тест</button>
      <button class="btn ghost" data-act="push-off">Отключить</button>
    </div>
    <p class="muted">Напоминания приходят утром (около 9:00 МСК) — за столько дней, сколько указано в подписке. Включи на каждом устройстве: на iPhone и на Mac.</p>`;

  return `
    ${store.isCloud ? `
      <h3 class="sec">Аккаунт</h3>
      <div class="card pad">
        <p>Вход выполнен: <b>${esc(S.user?.email)}</b></p>
        <p class="muted">Данные синхронизируются между всеми устройствами, где ты вошёл с этой почтой.</p>
        <button class="btn ghost" data-act="logout">Выйти</button>
      </div>` : `
      <div class="card pad warn">
        <b>Демо-режим</b>
        <p class="muted">Данные хранятся только в этом браузере. Чтобы включить синхронизацию между iPhone и Mac и push-напоминания, подключи Supabase по инструкции в README.</p>
      </div>`}

    <h3 class="sec">Уведомления</h3>
    <div class="card pad">${push}</div>

    <h3 class="sec">Валюта итогов</h3>
    <div class="card pad">
      <select data-set="currency">${CURRENCIES.map((c) => `<option ${c === S.mainCur ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <p class="muted">Суммы в других валютах пересчитываются по курсу ЦБ${ratesApproximate() ? ' (сейчас примерно — нет связи)' : ''}.</p>
    </div>

    <h3 class="sec">Данные</h3>
    <div class="card pad">
      <div class="row-btns">
        <button class="btn" data-act="export">Экспорт в JSON</button>
        <label class="btn">Импорт из JSON<input type="file" accept="application/json,.json" data-act="import" hidden></label>
      </div>
      <p class="muted">Резервная копия или перенос из демо-режима в облако.</p>
    </div>
    <p class="note">Подписки · версия 1.0</p>`;
}

// ---------- вход
function loginView() {
  return `
    <div class="login">
      <div class="empty-art">🦀</div>
      <h1>Подписки</h1>
      <p class="muted">${S.loginStep === 'signup' ? 'Создай аккаунт — потом войдёшь с ним на iPhone и Mac.' : 'Один аккаунт на iPhone и Mac.'}</p>
      <form data-form="login">
        <input type="email" name="email" placeholder="Email" autocomplete="username" required value="${esc(S.loginEmail)}">
        <input type="password" name="password" placeholder="Пароль (от 6 символов)" minlength="6" required
          autocomplete="${S.loginStep === 'signup' ? 'new-password' : 'current-password'}">
        <button class="btn primary wide">${S.loginStep === 'signup' ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
      <button class="btn ghost" data-act="login-switch">${S.loginStep === 'signup' ? 'Уже есть аккаунт — войти' : 'Нет аккаунта — создать'}</button>
    </div>`;
}

// ---------------------------------------------------------------- шторка: каталог
function openSheet(html) {
  sheet.innerHTML = `<div class="sheet-bg" data-act="close"></div><div class="sheet-panel" role="dialog">${html}</div>`;
  sheet.hidden = false;
  document.body.classList.add('locked');
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheet() {
  sheet.classList.remove('open');
  document.body.classList.remove('locked');
  setTimeout(() => { sheet.hidden = true; sheet.innerHTML = ''; }, 250);
}

let pickerCat = 'all';
let pickerQuery = '';

function openPicker() {
  pickerCat = 'all';
  pickerQuery = '';
  openSheet(`
    <div class="sheet-head">
      <button class="link" data-act="close">Отмена</button>
      <b>Новая подписка</b>
      <span></span>
    </div>
    <input class="search" type="search" placeholder="Поиск: Яндекс, Netflix, iCloud…" data-picker="q" autocomplete="off">
    <div class="chips">
      <button class="chip on" data-cat="all">Все</button>
      ${Object.entries(CATEGORIES).map(([id, c]) => `<button class="chip" data-cat="${id}">${c.emoji} ${c.label}</button>`).join('')}
    </div>
    <div class="catalog" id="catalog"></div>`);
  renderCatalog();
  if (matchMedia('(pointer:fine)').matches) $('.search', sheet)?.focus();
}

function renderCatalog() {
  const q = pickerQuery.trim().toLowerCase();
  const items = CATALOG.filter((s) => (pickerCat === 'all' || s.category === pickerCat)
    && (!q || s.name.toLowerCase().includes(q) || s.id.includes(q) || (s.domain || '').includes(q)));
  $('#catalog', sheet).innerHTML = `
    <button class="cat-item custom" data-custom="1">
      <span class="logo plus" style="--s:44px">＋</span>
      <span>${q ? `«${esc(pickerQuery.trim())}»` : 'Своя подписка'}</span>
    </button>
    ${items.map((s) => `
      <button class="cat-item" data-service="${s.id}">
        ${logo(s, 44)}<span>${esc(s.name)}</span>
      </button>`).join('')}`;
}

// ---------------------------------------------------------------- шторка: форма
let formState = null;

function openForm(sub, service) {
  const t = today();
  if (sub) {
    const e = enrich(sub);
    formState = { ...sub, period_count: e.period_count, shownDate: sub.active ? e.next : sub.start_date };
    service = CATALOG.find((x) => x.id === sub.service_id);
  } else if (service) {
    const p = service.plans[0];
    formState = {
      service_id: service.id, name: service.name, domain: service.domain, plan: p.name, price: p.price,
      currency: p.currency, period_unit: p.unit, period_count: p.count, category: service.category,
      remind_days: 1, notes: '', active: true, shownDate: t,
    };
  } else {
    formState = {
      service_id: null, name: pickerQuery.trim(), domain: '', plan: '', price: '', currency: S.mainCur,
      period_unit: 'month', period_count: 1, category: 'other', remind_days: 1, notes: '', active: true, shownDate: t,
    };
  }
  formState.service = service || null;
  const f = formState;
  const plans = service?.plans || [];

  openSheet(`
    <form data-form="sub" class="sub-form">
      <div class="sheet-head">
        <button type="button" class="link" data-act="close">Отмена</button>
        <b>${sub ? 'Подписка' : 'Новая подписка'}</b>
        <button class="link strong">Готово</button>
      </div>

      <div class="form-hero">
        ${logo(f, 56)}
        <input name="name" value="${esc(f.name)}" placeholder="Название" required class="title-input">
      </div>

      ${plans.length ? `
        <label class="flabel">Тариф</label>
        <div class="plans">
          ${plans.map((p, i) => `
            <button type="button" class="plan ${p.name === f.plan ? 'on' : ''}" data-plan="${i}">
              <span>${esc(p.name)}</span>
              <small>${p.price ? `${money(p.price, p.currency, true)} ${periodLabel(p.unit, p.count)}` : 'своя цена'}</small>
            </button>`).join('')}
        </div>
        <p class="hint">Цены в каталоге — ориентир, проверь сумму по своему чеку.</p>` : `
        <label class="flabel">Тариф</label>
        <input name="plan" value="${esc(f.plan)}" placeholder="Например: Семейный">`}
      ${plans.length ? `<input type="hidden" name="plan" value="${esc(f.plan)}">` : ''}

      <div class="grid2">
        <div><label class="flabel">Сумма</label>
          <input name="price" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(f.price)}" required></div>
        <div><label class="flabel">Валюта</label>
          <select name="currency">${CURRENCIES.map((c) => `<option ${c === f.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      </div>

      <label class="flabel">Как часто списывается</label>
      <div class="grid2">
        <div class="every"><span>каждые</span><input name="period_count" type="number" min="1" max="365" value="${f.period_count}" required></div>
        <select name="period_unit">
          ${[['day', 'дн.'], ['week', 'нед.'], ['month', 'мес.'], ['year', 'г.']].map(([u, l]) => `<option value="${u}" ${u === f.period_unit ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <label class="flabel">Дата ближайшего списания</label>
      <input name="date" type="date" value="${f.shownDate}" required>

      <div class="grid2">
        <div><label class="flabel">Напомнить</label>
          <select name="remind_days">${[0, 1, 2, 3, 5, 7, 14].map((n) => `<option value="${n}" ${n === Number(f.remind_days) ? 'selected' : ''}>${remindLabel(n)}</option>`).join('')}</select></div>
        <div><label class="flabel">Категория</label>
          <select name="category">${Object.entries(CATEGORIES).map(([id, c]) => `<option value="${id}" ${id === f.category ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
      </div>

      ${!f.service ? `<label class="flabel">Сайт (для логотипа)</label>
        <input name="domain" value="${esc(f.domain)}" placeholder="example.com" autocapitalize="off">` : ''}

      <label class="flabel">Заметка</label>
      <textarea name="notes" rows="2" placeholder="С какой карты, как отменить…">${esc(f.notes)}</textarea>

      ${sub ? `
        <label class="switch"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}><span>Активна</span></label>
        <button type="button" class="btn danger wide" data-act="delete">Удалить подписку</button>` : ''}
    </form>`);
}

function applyPlan(i) {
  const p = formState.service.plans[i];
  const form = $('form[data-form="sub"]', sheet);
  form.plan.value = p.name;
  if (p.price) form.price.value = p.price;
  form.currency.value = p.currency;
  form.period_unit.value = p.unit;
  form.period_count.value = p.count;
  sheet.querySelectorAll('.plan').forEach((b, j) => b.classList.toggle('on', j === i));
}

async function submitForm(form) {
  const f = formState;
  const fd = new FormData(form);
  const date = fd.get('date');
  const row = {
    id: f.id,
    service_id: f.service_id,
    name: fd.get('name').trim(),
    domain: (fd.get('domain') ?? f.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    plan: (fd.get('plan') || '').trim(),
    price: Number(fd.get('price')) || 0,
    currency: fd.get('currency'),
    period_unit: fd.get('period_unit'),
    period_count: Math.max(1, parseInt(fd.get('period_count'), 10) || 1),
    // если дату не трогали — сохраняем исходную точку отсчёта (важно для 31-го числа)
    start_date: f.id && date === f.shownDate ? f.start_date : date,
    category: fd.get('category'),
    remind_days: Number(fd.get('remind_days')),
    notes: (fd.get('notes') || '').trim(),
    active: f.id ? fd.get('active') === 'on' : true,
  };
  if (f.id && (row.period_unit !== f.period_unit || row.period_count !== Number(f.period_count))) row.start_date = date;
  try {
    await store.save(row);
    closeSheet();
    toast(f.id ? 'Сохранено' : 'Подписка добавлена');
    await reload();
  } catch (e) {
    console.error(e);
    toast('Ошибка сохранения: ' + (e.message || e));
  }
}

// ---------------------------------------------------------------- push
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushOn() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Разрешение не выдано'); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CONFIG.VAPID_PUBLIC_KEY) });
    await store.registerPush(sub);
    toast('Уведомления включены');
  } catch (e) {
    console.error(e);
    toast('Не получилось: ' + (e.message || e));
  }
}

async function pushOff() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await store.unregisterPush(sub.endpoint); await sub.unsubscribe(); }
  toast('Уведомления отключены на этом устройстве');
}

async function pushTest() {
  if (Notification.permission !== 'granted') { toast('Сначала включи уведомления'); return; }
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification('Подписки', { body: 'Так будут выглядеть напоминания о списаниях 🦀', icon: 'icons/icon-192.png', tag: 'test' });
}

// ---------------------------------------------------------------- экспорт / импорт
function exportJSON() {
  const rows = S.subs.map(({ id, user_id, created_at, updated_at, ...r }) => r);
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `podpiski-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJSON(file) {
  try {
    const rows = JSON.parse(await file.text());
    if (!Array.isArray(rows)) throw new Error('ожидался массив');
    const valid = rows.filter((r) => r.name && r.start_date && r.period_unit);
    await store.importMany(valid);
    toast(`Импортировано: ${valid.length}`);
    await reload();
  } catch (e) {
    toast('Файл не подошёл: ' + e.message);
  }
}

// ---------------------------------------------------------------- события
document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, [data-day], label');
  if (!el) return;
  const d = el.dataset;

  if (d.tab) { S.view = d.tab; render(); window.scrollTo(0, 0); return; }
  if (d.edit) { openForm(S.subs.find((s) => s.id === d.edit)); return; }
  if (d.day) { S.selDay = S.selDay === d.day ? null : d.day; render(); return; }
  if (d.month) {
    const [y, m] = S.month.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + Number(d.month), 1));
    S.month = dt.toISOString().slice(0, 7);
    S.selDay = null;
    render();
    return;
  }
  if (d.cat) {
    pickerCat = d.cat;
    sheet.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === el));
    renderCatalog();
    return;
  }
  if (d.service) { openForm(null, CATALOG.find((s) => s.id === d.service)); return; }
  if (d.custom) { openForm(null, null); return; }
  if (d.plan !== undefined) { applyPlan(Number(d.plan)); return; }

  switch (d.act) {
    case 'add': openPicker(); break;
    case 'close': closeSheet(); break;
    case 'toggle-paused': S.showPaused = !S.showPaused; render(); break;
    case 'delete':
      if (confirm(`Удалить «${formState.name}»?`)) {
        await store.remove(formState.id);
        closeSheet();
        toast('Удалено');
        await reload();
      }
      break;
    case 'logout': await store.signOut(); S.user = null; S.subs = []; S.view = 'list'; render(); break;
    case 'login-switch': S.loginEmail = $('input[name=email]')?.value || S.loginEmail; S.loginStep = S.loginStep === 'signup' ? 'signin' : 'signup'; render(); break;
    case 'push-on': await pushOn(); break;
    case 'push-off': await pushOff(); break;
    case 'push-test': await pushTest(); break;
    case 'export': exportJSON(); break;
    default: break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.dataset.picker === 'q') { pickerQuery = e.target.value; renderCatalog(); }
  // логотип своей подписки обновляется по мере ввода сайта
  if (e.target.name === 'domain' && formState) {
    const hero = $('.form-hero .logo', sheet);
    if (hero) hero.outerHTML = logo({ name: formState.name || '?', domain: e.target.value.trim() }, 56);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.set === 'currency') { S.mainCur = t.value; lsSet('podpiski.currency', t.value); render(); }
  if (t.dataset.act === 'import' && t.files[0]) importJSON(t.files[0]);
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.form;
  const btn = form.querySelector('button:not([type=button])');
  if (btn) btn.disabled = true;
  try {
    if (kind === 'sub') await submitForm(form);
    if (kind === 'login') {
      S.loginEmail = form.email.value.trim();
      const pw = form.password.value;
      if (S.loginStep === 'signup') await store.signUp(S.loginEmail, pw);
      else await store.signIn(S.loginEmail, pw);
      S.user = await store.getUser();
      if (!S.user) throw new Error('Не удалось войти. Проверь, что в Supabase отключено подтверждение email (README, шаг 2).');
      S.loginStep = 'signin';
      await reload();
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Ошибка');
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden) closeSheet();
});

// при возвращении в приложение подтягиваем изменения с другого устройства
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!store.isCloud || S.user)) reload();
});

// ---------------------------------------------------------------- старт
(async function start() {
  S.subs = store.cached();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
  try {
    await Promise.all([store.init(), initRates()]);
  } catch (e) {
    console.error(e);
    toast('Нет связи — показываю сохранённые данные');
    return;
  }
  if (store.isCloud) {
    S.user = await store.getUser();
    store.onAuthChange((u) => { const changed = !!u !== !!S.user; S.user = u; if (changed) reload(); });
    if (!S.user) { render(); return; }
  }
  await reload();
})();
