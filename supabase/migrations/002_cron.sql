-- =====================================================================
-- Ежедневный запуск напоминаний
-- Перед выполнением замени два значения:
--   <PROJECT_REF>  — id проекта (из адреса https://<PROJECT_REF>.supabase.co)
--   <CRON_SECRET>  — та же строка, что ты задал в секретах функции
-- Расписание в UTC: '0 6 * * *' = 09:00 по Москве.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- если задача уже была — удаляем, чтобы пересоздать
select cron.unschedule(jobid) from cron.job where jobname = 'podpiski-reminders';

select cron.schedule(
  'podpiski-reminders',
  '0 6 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body    := '{}'::jsonb
  );
  $$
);
