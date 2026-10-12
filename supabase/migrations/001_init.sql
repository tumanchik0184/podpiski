-- =====================================================================
-- Подписки — схема базы данных
-- Выполни целиком в Supabase: SQL Editor → New query → Run
-- =====================================================================

-- ---------- Подписки ----------
create table if not exists public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id    text,                         -- id сервиса из каталога (null = своя подписка)
  name          text not null,
  domain        text,                         -- для логотипа
  plan          text,                         -- название тарифа
  price         numeric(12,2) not null default 0 check (price >= 0),
  currency      text not null default 'RUB',
  period_unit   text not null default 'month' check (period_unit in ('day','week','month','year')),
  period_count  int  not null default 1 check (period_count between 1 and 365),
  start_date    date not null,                -- дата любого списания; от неё считаются следующие
  category      text,
  remind_days   int  not null default 1 check (remind_days between 0 and 30),
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists subscriptions_user_idx on public.subscriptions(user_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ---------- Устройства для push-уведомлений ----------
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

-- ---------- Журнал отправленных напоминаний (защита от дублей) ----------
create table if not exists public.reminder_log (
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  payment_date    date not null,
  sent_at         timestamptz not null default now(),
  primary key (subscription_id, payment_date)
);

-- ---------- Row Level Security: каждый видит только свои данные ----------
alter table public.subscriptions      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminder_log       enable row level security;  -- политик нет: доступ только у сервисной функции

drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own push devices" on public.push_subscriptions;
create policy "own push devices" on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Перерегистрация устройства (тот же endpoint) от того же пользователя
create or replace function public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_ua text)
returns void language sql security invoker as $$
  insert into public.push_subscriptions (endpoint, p256dh, auth, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_ua)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
    where push_subscriptions.user_id = auth.uid();
$$;

grant execute on function public.register_push(text, text, text, text) to authenticated;
