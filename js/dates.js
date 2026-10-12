// Расчёт дат списаний. Даты — строки 'YYYY-MM-DD', считаем в UTC, чтобы не было сдвигов часовых поясов.
// Этот файл без зависимостей: его же использует функция напоминаний на сервере.

const DAY = 86400000;

export function toDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(dt) {
  return dt.toISOString().slice(0, 10);
}

export function todayISO(timeZone = 'Europe/Moscow') {
  // en-CA даёт формат YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / DAY);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// k-е списание от якорной даты (k = 0 — сама якорная дата).
// Для месяцев день «прилипает» к исходному: 31 янв → 28 фев → 31 мар.
export function nthPayment(start, unit, count, k) {
  const a = toDate(start);
  if (unit === 'day' || unit === 'week') {
    const step = (unit === 'day' ? 1 : 7) * count;
    return toISO(new Date(a.getTime() + k * step * DAY));
  }
  const months = (unit === 'year' ? 12 : 1) * count * k;
  const total = a.getUTCMonth() + months;
  const y = a.getUTCFullYear() + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  const d = Math.min(a.getUTCDate(), daysInMonth(y, mo));
  return toISO(new Date(Date.UTC(y, mo, d)));
}

// Примерный размер периода в днях — для начального приближения
function approxDays(unit, count) {
  return { day: 1, week: 7, month: 30.436875, year: 365.2425 }[unit] * count;
}

// Ближайшее списание в дату today или позже
export function nextPayment(start, unit, count, today) {
  const diff = daysBetween(start, today);
  if (diff <= 0) return start;
  let k = Math.max(0, Math.floor(diff / approxDays(unit, count)) - 1);
  let d = nthPayment(start, unit, count, k);
  while (d < today) { k += 1; d = nthPayment(start, unit, count, k); }
  return d;
}

// Предыдущее (последнее прошедшее) списание до today, или null
export function prevPayment(start, unit, count, today) {
  const next = nextPayment(start, unit, count, today);
  if (next === start && start >= today) return null;
  let k = Math.max(0, Math.floor(daysBetween(start, next) / approxDays(unit, count)) - 1);
  let prev = null;
  for (let d = nthPayment(start, unit, count, k); d < next; d = nthPayment(start, unit, count, ++k)) {
    if (d < today) prev = d;
  }
  return prev;
}

// Все списания в интервале [from, to]
export function paymentsBetween(start, unit, count, from, to) {
  const out = [];
  let d = nextPayment(start, unit, count, from);
  let k = 0;
  // находим индекс найденной даты, чтобы шагать без накопления ошибки
  let probe = Math.max(0, Math.floor(daysBetween(start, d) / approxDays(unit, count)) - 1);
  while (nthPayment(start, unit, count, probe) < d) probe++;
  k = probe;
  while (d <= to) {
    out.push(d);
    k += 1;
    d = nthPayment(start, unit, count, k);
  }
  return out;
}

// Стоимость в пересчёте на месяц
export function monthlyCost(price, unit, count) {
  const perMonth = { day: 365.2425 / 12, week: 52.1775 / 12, month: 1, year: 1 / 12 }[unit];
  return (Number(price) * perMonth) / count;
}

export function addDaysISO(s, n) {
  return toISO(new Date(toDate(s).getTime() + n * DAY));
}
