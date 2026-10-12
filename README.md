# Подписки 🦀

Личный трекер подписок для iPhone и Mac: каталог сервисов с тарифами, общая сумма в месяц и в год, календарь списаний, разбивка по категориям, push-напоминания о списании.

Как устроено:
- **Веб-приложение (PWA)** без сборки: обычные HTML/CSS/JS. Хостится бесплатно на GitHub Pages. На iPhone и Mac ставится как отдельное приложение.
- **Supabase** (бесплатный тариф) хранит подписки, отвечает за вход по коду из письма и раз в день запускает функцию напоминаний.
- **Push** работает через стандартный Web Push. На iPhone для него нужна iOS 16.4+, на Mac — Safari из macOS Sonoma+.

```
index.html, css/, js/          — само приложение
  js/catalog.js                — каталог сервисов и тарифов (дополняй сам)
  js/config.js                 — ключи подключения
sw.js, manifest.webmanifest    — офлайн-режим, push, установка
supabase/migrations/           — SQL: таблицы и расписание
supabase/functions/            — функция push-напоминаний
```

---

## 0. Попробовать прямо сейчас (демо-режим)

Пока `js/config.js` пустой, приложение работает локально: данные хранятся только в браузере.

```bash
cd podpiski
python3 -m http.server 8000
```
Открой http://localhost:8000. Через `file://` не заработает, нужен именно сервер.

---

## 1. Supabase: проект и база

1. Зарегистрируйся на https://supabase.com и создай **New project**. Регион — Frankfurt (eu-central-1), тариф Free. Пароль базы сохрани, но он тут не понадобится.
2. **SQL Editor → New query**: вставь содержимое `supabase/migrations/001_init.sql` и нажми **Run**.
3. **Project Settings → API Keys**: скопируй **Project URL** и **publishable key** (если у тебя старый формат ключей — **anon public**).
   Этот ключ публичный, его можно хранить в репозитории: без входа данные не видны благодаря Row Level Security.

## 2. Вход по email и паролю

Письма не нужны: вход по email и паролю, подтверждение почты отключаем.

1. **Authentication → Sign In / Providers → Email**: выключи **Confirm email** и сохрани.
2. В приложении нажми «Нет аккаунта — создать», задай email и пароль. На втором устройстве войди с ними же.

## 3. Ключи для push (VAPID)

На Mac в терминале:
```bash
npx web-push generate-vapid-keys
```
Сохрани **Public Key** и **Private Key**. Ещё придумай длинную случайную строку **CRON_SECRET**, например так:
```bash
openssl rand -hex 24
```

## 4. Функция напоминаний

В папке проекта:
```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>        # id из адреса https://<PROJECT_REF>.supabase.co

npx supabase secrets set \
  VAPID_PUBLIC_KEY=<public key> \
  VAPID_PRIVATE_KEY=<private key> \
  VAPID_SUBJECT=mailto:<твоя почта> \
  CRON_SECRET=<секретная строка>

npx supabase functions deploy send-reminders --no-verify-jwt --use-api
```

Проверь, что всё работает: функция должна ответить JSON, а не ошибкой.
```bash
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders \
  -H "x-cron-secret: <секретная строка>" -H "Content-Type: application/json" \
  -d '{"dry":true}'
```

**Расписание.** Открой `supabase/migrations/002_cron.sql`, подставь `<PROJECT_REF>` и `<CRON_SECRET>`, затем выполни файл в SQL Editor. Функция будет запускаться каждый день в 09:00 по Москве. Время меняется в строке `'0 6 * * *'` (она в UTC).

## 5. Конфиг и публикация на GitHub Pages

1. Заполни `js/config.js`:
   ```js
   SUPABASE_URL: 'https://<PROJECT_REF>.supabase.co',
   SUPABASE_ANON_KEY: '<publishable key>',
   VAPID_PUBLIC_KEY: '<public key из шага 3>',
   ```
2. Создай репозиторий на GitHub (например `podpiski`) и залей проект:
   ```bash
   git init && git add . && git commit -m "Подписки"
   git branch -M main
   git remote add origin git@github.com:<логин>/podpiski.git
   git push -u origin main
   ```
3. В репозитории: **Settings → Pages → Build and deployment → Deploy from a branch**, ветка `main`, папка `/ (root)`.
   Через минуту приложение откроется по адресу `https://<логин>.github.io/podpiski/`.

> На бесплатном GitHub Pages работают только публичные репозитории. Код при этом будет открыт, но твои данные — нет: они лежат в Supabase и доступны только после входа. Приватный ключ VAPID и CRON_SECRET в репозиторий не попадают.

## 6. Установка

**iPhone:** открой адрес в Safari → «Поделиться» → **«На экран Домой»**. Запусти приложение с иконки, создай аккаунт (или войди), затем **Настройки → Включить на этом устройстве** и **Тест**.

**Mac:** открой адрес в Safari → меню **Файл → Добавить в Dock**. Войди тем же email и так же включи уведомления.

Напоминания с сервера можно проверить вручную:
```bash
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders \
  -H "x-cron-secret: <секретная строка>" -H "Content-Type: application/json" \
  -d '{"test":true}'
```

---

## Как пользоваться

- **＋** открывает каталог: выбери сервис, затем тариф. Сумма, валюта и период подставятся автоматически, их можно поправить. Если сервиса нет в каталоге, нажми «Своя подписка» и укажи сайт, логотип подтянется по нему.
- **Дата ближайшего списания** — от неё приложение само считает все следующие даты, включая «31-е число» в коротких месяцах.
- **Напомнить**: в день списания или за N дней. Push придёт утром на все устройства, где включены уведомления, по одному разу на каждое списание.
- **Пауза**: сними галочку «Активна». Подписка перестанет учитываться в суммах, но останется в списке.
- **Валюта итогов** настраивается в Настройках. Пересчёт идёт по курсу ЦБ РФ.
- **Экспорт/импорт JSON** — резервная копия. Этим же способом можно перенести данные из демо-режима в облако.

## Доработка

- Каталог: `js/catalog.js`. Цены там ориентировочные, на осень 2026.
- Расчёт дат продублирован в начале `supabase/functions/send-reminders/index.ts`: если меняешь `js/dates.js`, поправь и там. Функция без внешних зависимостей, её можно вставить прямо в редактор Supabase (Edge Functions → Via Editor).
- После изменений приложения достаточно сделать `git push`. Чтобы установленная копия подхватила обновление сразу, увеличь `VERSION` в `sw.js`.
