# Перенос на сервер Ubuntu

Проект запускается как служба systemd: стартует сам при загрузке сервера,
перезапускается при сбое, база лежит в `data/app.db` и **не стирается** (в
отличие от бесплатного Render).

Подходит Ubuntu 22.04 / 24.04, доступ по SSH с правами `sudo`.

## 0. Перед переносом — обязательно

- **Остановите старые копии.** Остановите сервис на Render (Suspend) и локальный
  сервер (Ctrl+C). У всех копий общий `SESSION_STRING` и общий токен бота: две
  работающие копии → Telegram аннулирует сессию (`AUTH_KEY_DUPLICATED`) и бот
  перестаёт получать сообщения.
- Никогда не останавливайте сервер через `kill -9` — только
  `sudo systemctl stop alert`.

## 1. Что переносим

- `alert-ubuntu.tar.gz` — код проекта (без `node_modules`, без секретов и базы).
- `.env` — ваши ключи. **В архив не входит специально**, переносится отдельно.
- `data/app.db` — по желанию: ваша локальная база (пользователи, каналы, темы).
  Без неё на сервере будет пустая база.

## 2. Копируем на сервер (с Windows, в PowerShell из папки проекта)

```powershell
scp alert-ubuntu.tar.gz .env ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА:~
scp data/app.db ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА:~      # по желанию
```

## 3. Распаковываем (на сервере)

```bash
sudo mkdir -p /opt/alert
sudo tar -xzf ~/alert-ubuntu.tar.gz -C /opt/alert
sudo mv ~/.env /opt/alert/.env
sudo mkdir -p /opt/alert/data && sudo mv ~/app.db /opt/alert/data/app.db   # если переносили базу
```

## 4. Правим `.env` под сервер

```bash
sudo nano /opt/alert/.env
```

Проверьте / поменяйте:

```
NO_AUTO_OPEN=1                    # на сервере нет браузера
PORT=3000
BOT_MODE=polling                  # webhook — только если у сервера есть домен с HTTPS
PUBLIC_BASE_URL=http://IP_СЕРВЕРА:3000
TURSO_DATABASE_URL=               # пусто — база в файле data/app.db
```

Остальное (`API_ID`, `API_HASH`, `SESSION_STRING`, `SESSION_ENCRYPTION_KEY`,
`GEMINI_API_KEY`, `GEMINI_MODEL`, `OPEN_ROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`) —
как на компьютере. `SESSION_ENCRYPTION_KEY` должен быть **тем же самым**, если
переносите базу: иначе сохранённые личные Telegram-сессии не расшифруются.

## 5. Устанавливаем и запускаем

```bash
sudo bash /opt/alert/deploy/install.sh
```

Скрипт сам: поставит Node.js 22, создаст системного пользователя `alert`,
установит зависимости, соберёт проект и запустит службу `alert`.

Если на сервере включён файрвол:

```bash
sudo ufw allow 3000/tcp
```

Сайт: `http://IP_СЕРВЕРА:3000`.

## 6. Проверка

```bash
sudo journalctl -u alert -f
```

В логах должны появиться строки:

- `Сервер запущен: http://localhost:3000`
- `Telegram userbot подключён`
- `Бот алертов @… готов, режим: polling`
- `Планировщик алертов запущен`

Если сервер в России, Google ответит «User location is not supported», и
запросы к ИИ будут уходить в OpenRouter (платно, с баланса) — в логах будет
строка `Gemini: … — отправляю тот же запрос в OpenRouter`.

## Управление

| Что | Команда |
|---|---|
| Логи в реальном времени | `sudo journalctl -u alert -f` |
| Остановить (штатно) | `sudo systemctl stop alert` |
| Запустить | `sudo systemctl start alert` |
| Перезапустить | `sudo systemctl restart alert` |
| Статус | `sudo systemctl status alert` |

## Обновление на новую версию

```bash
sudo tar -xzf ~/alert-ubuntu.tar.gz -C /opt/alert   # .env и data/ не затрагиваются
sudo bash /opt/alert/deploy/install.sh
```

## Резервная копия базы

```bash
sudo systemctl stop alert
sudo cp /opt/alert/data/app.db ~/app.db.backup-$(date +%F)
sudo systemctl start alert
```
