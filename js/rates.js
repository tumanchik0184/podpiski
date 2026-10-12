// Курсы валют ЦБ РФ (cbr-xml-daily.ru), кэш на 12 часов.
// Если сеть недоступна — берём последний кэш или примерные курсы.

const KEY = 'podpiski.rates';
const FALLBACK = { RUB: 1, USD: 81, EUR: 94, AMD: 0.21, AED: 22, KZT: 0.16, TRY: 1.9, GBP: 108 };

let rates = null;      // сколько рублей стоит 1 единица валюты
let approximate = true;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

export async function initRates() {
  const c = load();
  if (c?.rates) { rates = c.rates; approximate = false; }
  if (c && Date.now() - c.at < 12 * 3600e3) return;
  try {
    const r = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { cache: 'no-store' });
    const j = await r.json();
    const out = { RUB: 1 };
    for (const [code, v] of Object.entries(j.Valute)) out[code] = v.Value / v.Nominal;
    rates = out;
    approximate = false;
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), rates: out })); } catch { /* ignore */ }
  } catch {
    if (!rates) { rates = FALLBACK; approximate = true; }
  }
}

export function convert(amount, from, to) {
  const r = rates || FALLBACK;
  if (from === to) return amount;
  const a = r[from] ?? FALLBACK[from];
  const b = r[to] ?? FALLBACK[to];
  if (!a || !b) return NaN;
  return (amount * a) / b;
}

export const ratesApproximate = () => approximate;
