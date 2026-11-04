# Халява: отчёт проверяющего

Ведёт freebies-reviewer. Сюда пишутся проблемы и что исправлено. Код проверяющий не правит.

## Контракт (5 ноября 2026)

Итог: CONTRACT_OK после второй проверки. Первая проверка нашла три блокирующих замечания, все исправлены.

Проверено против кода: `outboxRepo.enqueueStatements`, `holdPolicy.holdUntil/HoldInput`, `messageFormat.OutgoingPart/escapeHtml`, `notifier`, `sender`, `destinationsRepo.getLinkByUser`, `IUserBotReader.getMessagesInWindow(channel, cutoff, max?)`, `bot.ts`, `server.ts`, `database.ts`, `app.ts`, `analyzeService.loadUnifiedPosts`.

Что в порядке:
- У каждого файла один владелец. Общие `package.json`, `src/db/database.ts`, `src/app.ts`, `src/server.ts` у freebies-backend. `.firecrawl/` в `.gitignore`. Коммит по именам файлов, `data/` не коммитится.
- Сигнатуры совпадают с кодом (`enqueueStatements`, `HoldInput` с `digestHours: 0`, `OutgoingPart`, `escapeHtml`, `loadUnifiedPosts`, `getLinkByUser`, `getMessagesInWindow`).
- Чужие файлы не правятся: путь через outbox, holdPolicy, Notifier и sender обходится без правок.
- Повторы алертов: PK `(user_id, deal_id)` плюс простой `INSERT` в одном batch, `dedup_key UNIQUE`, флаг «уже идёт», тест на два запуска подряд.
- Адресов API хватает: вкладка «Халява», общая лента с переключателем и меткой вида, выбор профиля при первом входе, магазины и категории, `breakQuiet` (по умолчанию false), сухой прогон, карточка акции.
- Правила CLAUDE.md: стек, Ponytail, нейросеть только через `llmClient.ts`, только для новых `dedup_key`, таймаут 10 с, только да/нет и категория; robots.txt, данные людей не хранятся, реальных отправок нет.

### Замечания первой проверки: закрыто

- К1 (рассылка старой ленты): закрыто. Доставка по `published_at >= now - 3600` и `muted = 0`, первая успешная проверка источника пишет `muted = 1`, записи старше суток не сохраняются, тест обязателен. Остаток (акция без даты, висящая дольше 7 дней, после уборки вставится заново) помечен `ponytail`, принято.
- К2 (дубль при параллельном выпуске): закрыто. Флаг «уже идёт», try/catch на пару, тест на два запуска.
- К3 (`telegram`): закрыто. Через `IUserBotReader.getMessagesInWindow`, интервал от 120 с, в `public_posts` не пишет.
- Не блокирующие 1 - 13: приняты и внесены в контракт, кроме 10 и 12, которые записаны как указания в п. 4 и п. 5.

### Мелочи второй проверки, не блокируют

1. Сухой прогон принимает `minutes` до 1440, а доставка берёт только последний час. Для акций старше часа `reason` не определён: либо `expired`, либо дописать причину `too_old`. Выбрать любой вариант, но одинаково в `dealDelivery.ts` и в preview.
2. Первый опрос источника с `last_ok_at IS NULL`: «успешная» проверка должна включать пустой результат, иначе источник без подходящих акций останется в режиме `muted` навсегда. Проставлять `last_ok_at` при любом успехе, в том числе 304 и пустой разбор. Проверит этап backend.
3. На этапах проверять: `bot.callbackQuery(/^fr:/)` стоит до общего `callback_query:data` и не вызывает `next()`; `startFreebiesWorker` вызывается после взятия замка и его `stop()` есть в `shutdown`.

## Этапы

(пока нет)
