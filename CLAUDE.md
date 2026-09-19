# gram-pervonah — Telegram AI-алертер (прототип)

Что это: Telegram-юзербот, который читает посты из публичных каналов за
выбранный период, фильтрует их по свободной теме, которую вводит
пользователь, и присылает ИИ-саммари вместо того, чтобы читать каналы
руками. Управление — через локальный HTML-интерфейс (`public/`), без
Telegram Mini App (это в планах, не реализовано).

Полный бизнес-контекст, целевая (будущая) архитектура и история решений —
в `docs/project-context.md`. Финальный принятый техстек и подробная
архитектура БД под многопользовательскую модель (каждый пользователь
подключает свой Telegram-аккаунт) — в `docs/tech-stack-final.md`, это
источник истины по актуальным решениям. `docs/tech-stack-review.md` —
более старая ревизия стороннего техстека, оставлена для истории. Читать
по необходимости, не обязательно в каждой сессии.

## Происхождение кода

Форк/переделка `github.com/litury/gram-pervonah` — изначально это был бот
для авто-реакций и авто-комментариев в чужих каналах. Функции реакций и
комментариев (`src/modules/CommentModule/`, реакции в `UserBot.ts`)
закомментированы/отключены, не удалены — на случай, если понадобятся
позже. Не включать их обратно без явного запроса.

## Важное расхождение с ранее планировавшейся архитектурой

Это сознательно **упрощённый прототип**, а не отказ от прежнего плана.
Что упрощено по сравнению с целевой архитектурой (детали в
`docs/project-context.md`):

- Node.js + ts-node, а не Bun
- Только публичные каналы через MTProto (GramJS), нет RSS-гибрида
- Двухступенчатый фильтр (keyword → фолбэк на полный ИИ-анализ корпуса),
  а не трёхслойный (keyword → эмбеддинги → LLM)
- Одна модель — Gemini 3.1 Flash-Lite, а не Groq+Gemini комбинация
- Render, а не Railway
- Ручной `SESSION_STRING` через `.env`, а не magic-link реавторизация

Цель прототипа — проверить, достаточно ли простой связки
"keyword-фильтр + одна ИИ-модель" по качеству, прежде чем вкладываться в
трёхслойный пайплайн. Не "упрощай ещё сильнее" и не "давай сразу строй
целевую архитектуру" без явного запроса пользователя — сейчас стадия
тестирования гипотезы.

## Стек и команды

- Рантайм: Node.js >=22.13.0, TypeScript, `ts-node` (без сборки для
  разработки; `npm run build` → `tsc` → `dist/` только для прод-запуска)
- Backend: Express 5
- БД: **`node:sqlite`** (`DatabaseSync`), не `better-sqlite3` — сознательный
  выбор, см. раздел "Известные грабли" ниже
- Telegram: `telegram` (GramJS), MTProto-юзербот, не Bot API
- ИИ: Gemini REST API напрямую через `fetch` (без SDK) — весь код вызова
  ИИ изолирован в `src/modules/AiModule/geminiClient.ts`, чтобы смена
  провайдера (Groq, GigaChat) была правкой одного файла
- Frontend: чистый HTML/CSS/JS без фреймворка, `public/`

Команды:

```bash
npm install
npm run dev          # старт сервера разработки (ts-node src/server.ts)
npm run build        # tsc → dist/
npm start            # прод-запуск (тоже ts-node, см. package.json)
npm run generate-session   # разовая генерация SESSION_STRING для .env
npm test             # node:test, 28 тестов
```

Тесты запускаются явным списком файлов (`node --require ts-node/register
--test <files>`), не через discovery — так исторически обошли проблему с
расширением `.ts`. При добавлении нового тестового файла его нужно
дописать в `scripts.test` в `package.json`, иначе он не запустится.

## Структура проекта

```
src/
  app.ts                 # Express-приложение, роуты (без listen)
  server.ts              # запуск app.ts, открывает браузер (open)
  index.ts               # legacy: старый CLI-вход бота реакций/комментариев
  db/
    database.ts           # getDb() — singleton node:sqlite, схема
    channelsRepo.ts        # CRUD каналов + нормализация username
    postsRepo.ts            # вставка постов (дедуп по UNIQUE), выборка по времени
  modules/
    UserBotModule/
      UserBot.ts            # обёртка над GramJS-клиентом; реакции/комменты закомментированы
      IUserBotReader.ts     # минимальный read-only интерфейс — ради DI в тестах
      windowPagination.ts   # чистая функция постраничного сбора сообщений за окно времени
    FetchModule/fetchService.ts     # оркестрация: каналы → UserBot → БД
    FilterModule/keywordFilter.ts   # подстрочный keyword-фильтр (первая ступень)
    AiModule/
      geminiClient.ts        # единственное место с HTTP-вызовами к Gemini
      analyzeService.ts       # вторая ступень: релевантность + саммари
  utils/time.ts            # парсинг пресетов времени (5м…10ч) в unix-диапазоны
  tests/                  # keywordFilter, time, windowMessages, api — 28 тестов
public/
  index.html, style.css, app.js   # вкладки: каналы / поиск-по-теме / результаты
docs/
  project-context.md      # бизнес-контекст, целевая архитектура, история
  tech-stack-review.md    # ревизия стороннего техстека
```

## Правила безопасности с credentials — соблюдать всегда

`SESSION_STRING` — это фактически полный доступ к Telegram-аккаунту,
`GEMINI_API_KEY` — платёжный доступ к API. Оба:

- живут только в `.env` (в `.gitignore`) или в переменных окружения
  хостинга (Render → Environment)
- **никогда** не должны появляться в коммитах, в этом файле, в других
  документах, в выводе команд, которые могут попасть в чат/лог
- если пользователь просит что-то продиагностировать через вывод `.env`
  или переменных окружения — маскировать значения, показывать только факт
  наличия/отсутствия переменной, не сами значения

## Текущее состояние деплоя

Задеплоено на **Render** (бесплатный тариф) — не Railway, как
предполагалось в целевой архитектуре. Причина именно Render: Gemini API
не отвечает на запросы с российских IP, а Render даёт сервер за пределами
РФ. Пользователь подтвердил: деплой работает, все функции протестированы
на проде.

Особенности free-тарифа Render, которые нужно держать в голове при любых
изменениях, влияющих на БД или на время отклика:

- диск эфемерный — без платного Disk файл SQLite (`data/app.db`) стирается
  при каждом редеплое
- сервис засыпает после ~15 минут неактивности, первый запрос после сна
  долгий

## Известные грабли (уже решённые — не наступать снова)

- **`better-sqlite3` на Windows падает при `npm install`** без Visual
  Studio C++ Build Tools (нативная сборка). Решено переходом на встроенный
  `node:sqlite` — держать этот выбор, не откатывать на `better-sqlite3`
  без веской причины.
- `node:sqlite` не даёт `.pragma()` и `.transaction()`, как
  `better-sqlite3` — вместо pragma используется `db.exec('PRAGMA ...')`,
  вместо `.transaction()` — ручной `BEGIN/COMMIT/ROLLBACK` (см.
  `postsRepo.ts`). `.all()/.get()` возвращают
  `Record<string, SQLOutputValue>`, поэтому в репозиториях стоят
  `as unknown as X` касты — это осознанно, не баг типизации.
- **Репозиторий GramJS (`gram-js/gramjs`) заархивирован 14 июля 2026 года,
  read-only.** Решение зафиксировано в `docs/tech-stack-final.md` (раздел
  3): переходить на `teleproto` — активно поддерживаемый форк, обратно
  совместимый по API и по формату `session string` (замена импорта
  `"telegram"` → `"teleproto"` в большинстве мест). Не откладывать эту
  миграцию как "когда-нибудь" — зависимость `telegram` в `package.json`
  сейчас указывает на неподдерживаемую библиотеку.
- **teleproto's bundled `.d.ts` has type definition compatibility issues
  with TypeScript 5.2.2** — Buffer is used as generic (TS2315 errors in 45+
  places), missing type aliases (InlineKeyboard, ReplyKeyboard in define.d.ts).
  These errors surface during module resolution (not fixable with
  `@ts-expect-error` on import lines), don't affect runtime behavior, and all
  tests pass. Solution: `"skipLibCheck": true` in `tsconfig.json` suppresses
  .d.ts validation for node_modules. Keep this flag — it's the standard
  workaround for library type definition issues. Don't remove without
  re-checking teleproto's typings first.

## Тестовая стратегия проекта

Тесты специально спроектированы так, чтобы не требовать реального
Telegram-аккаунта или реального Gemini-ключа:

- `IUserBotReader` — минимальный интерфейс, под который подставляется
  фейковый клиент в тестах вместо GramJS
- `windowPagination.ts` вынесена в чистую функцию именно ради
  тестируемости постраничной логики через инжектируемый фейковый
  page-fetcher
- Приоритет при добавлении новой логики — стараться держать её в чистых
  функциях с DI, а не в коде, завязанном напрямую на GramJS/Gemini/сеть,
  чтобы новую логику можно было так же покрыть тестами без реальных
  внешних вызовов

## Что дальше (озвученные, но не реализованные планы)

- Семантический слой дедупликации/эмбеддингов (шаг к целевому
  трёхслойному пайплайну)
- Мульти-провайдерный адаптер под LLM (Groq, GigaChat) поверх уже
  изолированного `geminiClient.ts`
- Миграция интерфейса в Telegram Mini App
- Приватные каналы через MTProto (сейчас — только публичные)

Не начинать эти пункты по умолчанию — только по явному запросу
пользователя, текущая стадия — обкатка того, что уже есть.
