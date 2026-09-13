# Marketplace API

ДЗ №1 (hw-09):

**Обраний варіант contract-частини: А (consumer-driven Pact).** Консюмер `marketplace-web`
у `test/consumer.pact.test.mjs` декларує очікування до `GET /orders/{id}`, «код фронта»
(`test/orders-client.mjs`) ганяється проти mock-провайдера, контракт пишеться у
`pacts/marketplace-web-marketplace-api.json`.

Сам сервер — NestJS з in-memory даними; додатково на кордоні стоїть `express-openapi-validator`
(запити й відповіді звіряються зі спекою, помилки віддаються як `application/problem+json`).

## Вимоги

Node.js ≥ 22.12.0, Docker з Compose (для Postgres та образу).

## Запуск

```bash
npm install
cp .env.example .env
mkdir -p secrets && printf 'marketplace_a:marketplace_dev' > secrets/db_password
npm run db:up
npm start
```

Сервер слухає `http://localhost:3000`. Порт задається змінною `PORT`:

```bash
PORT=8080 npm start
```

## Configuration

Усі змінні описані однією zod-схемою у `src/config/env.schema.ts`. Схема виконується на старті
через `validate` у `ConfigModule.forRoot`: зламана або відсутня змінна означає, що процес не стартує,
у виводі — назва змінної та причина, exit code ≠ 0. У коді конфіг читається лише через
`ConfigService<Env, true>`, прямих звернень до `process.env` немає.

| Змінна | Обовʼязкова | Дефолт | Призначення |
| --- | --- | --- | --- |
| `NODE_ENV` | ні | `development` | режим: `development` / `test` / `production` |
| `PORT` | ні | `3000` | HTTP-порт API |
| `DB_URL` | так | — | URL Postgres **без облікових даних**, напр. `postgres://localhost:5433/marketplace` |
| `DB_PASSWORD_FILE` | так | — | шлях до файла-секрета формату `user:password`, напр. `secrets/db_password` |

Контракт змінних — `.env.example` (у git). Реальний `.env` і тека `secrets/` — у `.gitignore`
та `.dockerignore`, у docker-образ вони не потрапляють.

Облікові дані БД застосунок читає не з env, а з файла `DB_PASSWORD_FILE` у форматі `user:password`:
пул `pg.Pool` створює зʼєднання через власний `Client`, який перечитує файл на кожне нове зʼєднання.
Тому і користувача, і пароль можна ротувати без рестарту.

Postgres для локального запуску — `docker-compose.yml` (порт хоста `5433`, щоб не конфліктувати
з локальним Postgres; `npm run db:up` чекає на healthcheck, тож `npm run db:up && npm start` не
стартує раніше за готовність БД). `db/init.sql` створює дві рівноправні login-ролі `marketplace_a`
і `marketplace_b` (обидві — члени групової ролі `marketplace`, власника бази) зі стартовим паролем
`marketplace_dev`. Стартовий вміст файла-секрета — `marketplace_a:marketplace_dev`. Після
`npm run db:down` (`docker compose down -v`) база повертається до стартового пароля, а файл
лишається з ротованим — поверніть у файл стартове значення перед наступним `npm run db:up`:

```bash
printf 'marketplace_a:marketplace_dev' > secrets/db_password
```

Якщо `/health` відповідає `503` з `password authentication failed`, файл і БД розійшлися.
Синхронізуйте пароль ролі з файлом:

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -c "ALTER ROLE $(cut -d: -f1 secrets/db_password) PASSWORD '$(cut -d: -f2 secrets/db_password)'"
```

### Ротація пароля БД без рестарту

1. Запамʼятайте uptime: `curl localhost:3000/health`.
2. Виконайте `bash rotate.sh`. Скрипт підвантажує `.env`, бере шлях до файла з `DB_PASSWORD_FILE`
   і назву бази з `DB_URL`, далі за схемою alternating users: визначає поточну роль із файла →
   `ALTER ROLE` з новим паролем для **іншої** ролі → атомарно (через `mv`) перезаписує файл на
   `інша_роль:новий_пароль` → закриває зʼєднання попередньої ролі (`pg_terminate_backend`).
   Поточна роль під час ротації не змінюється, тому вікна зі старим паролем немає.
3. Повторіть `curl localhost:3000/health` — відповідь `200`, `db: ok`, uptime більший за попередній:
   процес не перезапускався, нові зʼєднання пулу взяли облікові дані з файла.

```bash
curl -s localhost:3000/health; bash rotate.sh; curl -s localhost:3000/health
```

### Перевірки конфігурації

Fail-fast (без `.env`, щоб dotenv не підхопив змінну з файла):

```bash
mv .env /tmp && env -u DB_URL npm run start; echo "exit=$?"; mv /tmp/.env .
```

`.env.example` синхронний зі схемою (exit 1, якщо файл відстав):

```bash
npm run check:env
```

Секрет не в git:

```bash
git status --ignored --porcelain | grep -E '^!! .*\.env$'; git ls-files | grep -c '\.env$'
```

Секрет не в образі:

```bash
docker build -t myapp . && docker run --rm myapp ls -a /app && docker run --rm myapp sh -c 'cat /app/.env' 2>&1; docker inspect --format '{{.Config.Env}}' myapp
```

## Що є в контракті

| Ресурс | Операції |
| --- | --- |
| `/products` | `GET /products` (cursor-пагінація), `POST /products` (Idempotency-Key), `GET /products/{id}` |
| `/orders` | `GET /orders` (cursor-пагінація), `POST /orders` (Idempotency-Key), `GET /orders/{id}` |

- **Cursor-пагінація**: `?limit=&cursor=`, відповідь `{ items, next_cursor }`, `next_cursor: null` — сторінок більше немає. Курсор — непрозорий токен.
- **Idempotency-Key**: обовʼязковий header на обох POST. Той самий ключ + те саме тіло → та сама відповідь `201` + `Idempotency-Replay: true`; той самий ключ + інше тіло → `422`.
- **problem+json**: кожна помилка — `application/problem+json` зі схемою `Problem` (`type`, `title`, `status`, `detail`, `instance`).
- Гроші — цілі копійки (`price_cents`, `total_cents`).

## Перевірки

Contract-тест консюмера (створює `pacts/*.json`):

```bash
npm run test:pact
```

```bash
ls pacts/*.json
```

Спека валідна (`redocly lint`, warnings дозволені, errors — ні):

```bash
npm run spec:lint
```

Бандл спеки у `spec.json`:

```bash
npm run spec:bundle
```

Обсяг спеки та параметр Idempotency-Key (по зібраному `spec.json`):

```bash
node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));console.log('операцій:',ops.length,'· ресурсів:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);console.log('Idempotency-Key: required =',idem?.required,'· опис, символів =',(idem?.description??'').trim().length)"
```

Grep-перевірки контракту:

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml; grep -c 'next_cursor' openapi/openapi.yaml; grep -c 'application/problem+json' openapi/openapi.yaml
```
