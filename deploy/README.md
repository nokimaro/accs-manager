# Деплой: panel.159.team

Пуш в `main` → CI (`.github/workflows/ci.yml`): `checks` → `e2e` → `publish` → `deploy`.

1. **publish** собирает образ (`Dockerfile`, target `api`, `GIT_SHA` = коммит) и кладёт его в GHCR:
   `ghcr.io/nokimaro/accs-manager:<sha>` и `:main`.
2. **deploy** (GitHub environment `production`, только ветка `main`) заходит по SSH на сервер ключом,
   который умеет ровно одно — `deploy <sha>` (forced command `deploy-ssh`), и затем ждёт, пока
   `https://panel.159.team/api/healthz` вернёт `version` и `workerVersion` = этот коммит.
3. На сервере `deploy-ssh` проверяет, что коммит есть в `origin/main`, переключает клон репозитория на него
   и запускает `deploy.sh`: `docker compose pull` → `up -d --wait` (сначала миграции `accs-migrate`, затем `accs-api`
   и `accs-worker`). Старый воркер останавливается до старта нового (graceful, до 30 с): два воркера никогда не держат
   одни и те же Telegram-сессии, а advisory lock в БД страхует от второго экземпляра.

## Сервер

Staging-бокс HOSTKEY (Ubuntu 24.04), общий с p2c — их контейнеры и туннели не трогаем. Адрес в репозиторий не пишем
(он публичный): `gh variable get DEPLOY_HOST --env production`.
Снаружи открыт только SSH (ключи + fail2ban), сайт доступен только через Cloudflare Tunnel.

| Что | Где |
|---|---|
| Приложение | `/opt/accs-manager` (владелец `accs-deploy`, в группе `docker`) |
| Секреты | `/opt/accs-manager/.env` (`600`): `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEY`, `PUBLIC_ORIGIN`, `TRUST_PROXY=true`, `API_BIND=127.0.0.1`, `API_PORT=3300` |
| Код и compose-файлы | `/opt/accs-manager/repo` — клон, переключается на деплоимый коммит |
| Текущая версия | `/opt/accs-manager/deployed-sha` |
| Forced command | `/usr/local/bin/accs-deploy-ssh` (root) ← `deploy/deploy-ssh` |
| Ключ CI | `/home/accs-deploy/.ssh/authorized_keys` (root, `restrict,command=…`) |
| Туннель | `cloudflared-accs.service`, конфиг `/etc/cloudflared/accs-manager.yml` ← `deploy/cloudflared-accs.yml`, удостоверение `/etc/cloudflared/accs-manager.json`, метрики `127.0.0.1:20243` |
| Обновление cloudflared | drop-in `/etc/systemd/system/cloudflared-update.service.d/restart-accs.conf` |

Порты на боксе: 3000, 3001, 3100 заняты p2c, поэтому API слушает `127.0.0.1:3300`. Метрики туннелей: 20241 — staging p2c,
20242 — p2c-pgon, 20243 — наш.

**`APP_ENCRYPTION_KEY` храните отдельно от дампов БД** (менеджер паролей): без него зашифрованные настройки
(токен бота, api_hash, ключ proxy-store) и auth keys Telegram-аккаунтов (`account_auth`) не восстановить —
аккаунты придётся добавлять заново.

**Воркер упал или `worker: down`:** `docker logs accs-worker`; `docker restart accs-worker`. Пока воркер лежит,
API работает, но коды не собираются и прокси не проверяются; после старта он догружает пропущенные коды.

## Частые действия

```bash
ssh root@"$(gh variable get DEPLOY_HOST --env production)"
cd /opt/accs-manager
cat deployed-sha
sudo -u accs-deploy docker compose --project-directory repo -f repo/compose.yml -f repo/compose.prod.yml --env-file .env ps
docker logs --tail 100 accs-api
docker logs --tail 100 accs-worker      # «accounts: connected», «codes: watching @VerificationCodes»
curl -s http://127.0.0.1:3300/api/healthz   # worker: ok|down, workerVersion

# админ (пароль — из stdin, в историю shell не попадает)
docker exec -i accs-api node apps/api/src/cli.ts admin:create --login <login> --password-stdin

# туннель
systemctl status cloudflared-accs
curl -s http://127.0.0.1:20243/metrics | grep ha_connections   # здоровое значение — 4
```

**Откат:** перезапустить workflow нужного коммита из `main` (Actions → ci → Re-run jobs → `deploy`)
или на сервере: `sudo -u accs-deploy bash -c 'cd /opt/accs-manager/repo && git checkout <sha> && deploy/deploy.sh <sha>'`.

**Правка маршрутов туннеля — только в `deploy/cloudflared-accs.yml`**, затем на сервере:
скопировать в `/etc/cloudflared/accs-manager.yml`,
`cloudflared tunnel --config /etc/cloudflared/accs-manager.yml ingress validate`, `systemctl restart cloudflared-accs`.
