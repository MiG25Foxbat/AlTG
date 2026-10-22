#!/usr/bin/env bash
# Установка и обновление на Ubuntu. Запуск из распакованной папки проекта:
#   sudo bash deploy/install.sh
# Повторный запуск = обновление: .env и база в data/ не трогаются.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER=alert

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите через sudo: sudo bash deploy/install.sh"
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "Нет файла $APP_DIR/.env — скопируйте его с компьютера (см. deploy/UBUNTU.md, шаг 3)."
  exit 1
fi

echo "== 1/5 Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update
  apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== 2/5 Системный пользователь $APP_USER"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "== 3/5 Зависимости и сборка"
cd "$APP_DIR"
sudo -u "$APP_USER" -H npm ci
sudo -u "$APP_USER" -H npm run build
sudo -u "$APP_USER" -H npm prune --omit=dev

echo "== 4/5 Сервис systemd"
sed "s#/opt/alert#$APP_DIR#g" deploy/alert.service > /etc/systemd/system/alert.service
systemctl daemon-reload
systemctl enable alert >/dev/null
systemctl restart alert

echo "== 5/5 Готово"
sleep 3
systemctl --no-pager --lines=15 status alert || true
echo
echo "Логи: sudo journalctl -u alert -f"
echo "Сайт: http://<IP-сервера>:$(grep -E '^PORT=' .env | cut -d= -f2 | grep . || echo 3000)"
