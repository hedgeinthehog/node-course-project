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
cp secrets/db_password.example secrets/db_password
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

| Змінна | Обовʼязкова | Дефолт | Призначення | Джерело |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | ні | `development` | режим: `development` / `test` / `production` | `.env` (dev) / env оточення (prod) |
| `PORT` | ні | `3000` | HTTP-порт API | `.env` (dev) / env оточення (prod) |
| `DB_URL` | так | — | URL Postgres **без облікових даних**, напр. `postgres://localhost:5433/marketplace`; вказує на базу з `db/schema.sql` | сховище: локальний `.env` поза git (dev), env оточення платформи (prod) |
| `DB_PASSWORD_FILE` | так | — | шлях до файла-секрета формату `user:password`, напр. `secrets/db_password` | сховище: файл-секрет поза git, ротується `rotate.sh`; шаблон — `secrets/db_password.example` |

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
cp secrets/db_password.example secrets/db_password
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

## База даних

Схема Marketplace — `db/schema.sql`: `users`, `products`, `orders`, `order_items`, 4 зовнішні ключі,
CHECK на статуси, ціни й кількості, `timestamptz` для часу. Гроші — цілі копійки (`price_cents`,
`total_cents`, integer/bigint), як і в OpenAPI-контракті: це точна арифметика без float і без
рядкових decimal. У `products` є генерована колонка `search_vector tsvector` під повнотекстовий пошук.

- Головна таблиця: **`orders`** (300 000 рядків після seed).
- Таблиця пошуку (q4): **`products`** (200 000 рядків).

Дев-креденшели стенда лежать у `docker-compose.yml` (`postgres` / `postgres`, база `marketplace`,
порт хоста `5433`); тека `db/` змонтована в контейнер як `/db`, а робоча тека psql у контейнері — `/`,
тому шляхи `db/schema.sql` тощо в командах нижче працюють як є.

Підняти базу:

```bash
docker compose up -d --wait
```

Підключитись:

```bash
docker compose exec -T postgres psql -U postgres -d marketplace
```

Повний цикл (той самий, що виконує грейдер) на чистому томі:

```bash
docker compose down -v && docker compose up -d --wait
```

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -f db/schema.sql
```

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -f db/seed.sql
```

EXPLAIN «до» (кожен запит має дати `Seq Scan`):

```bash
for q in q1 q2 q3 q4; do docker compose exec -T postgres psql -U postgres -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"; done
```

Індекси та статистика:

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -f db/indexes.sql && docker compose exec -T postgres psql -U postgres -d marketplace -c "ANALYZE;"
```

EXPLAIN «після» (без `Seq Scan`, у плані — індекс із `db/indexes.sql`; q4 прожени 2–3 рази, перший іде по холодному GIN):

```bash
for q in q1 q2 q3 q4; do docker compose exec -T postgres psql -U postgres -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"; done
```

Мертві індекси (очікується порожній вивід):

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -Atc "SELECT indexrelname FROM pg_stat_user_indexes WHERE schemaname='public' AND idx_scan = 0 AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);"
```

Плани «до»/«після», пояснення та секція «Морфологія» — у `db/OPTIMIZATIONS.md`.

## ORM: TypeORM поверх схеми ДЗ #12

Схема з `db/schema.sql` переїхала в код: `src/entities/` (4 entities), `src/migrations/` (початкова
міграція), `src/data-source.ts`. У DataSource `synchronize: false` — схему змінюють лише міграції.
`db/schema.sql` лишається артефактом ДЗ #12 для циклу EXPLAIN;

Команди (усі, що ходять у базу, загорнуті в `scripts/with-secrets.sh dev`):

```bash
npm run build
npm run migrate          # застосувати міграції
npm run migrate:show     # [X] — застосовані
npm run migrate:revert   # відкотити останню
npm run seed             # детермінований ідемпотентний seed
npm run demo:nplus1      # N+1 «до/після»
npm run report           # виторг по продавцях через QueryBuilder
```

Початкову міграцію згенеровано через `migration:generate`, прочитано й поправлено руками: додано чотири
індекси з ДЗ #12, яких декоратори TypeORM не вміють виразити (`DESC`, partial з `INCLUDE`, expression
`lower(email)`, GIN) — в entities вони позначені `@Index(..., { synchronize: false })`, тож генератор їх не
чіпає; зашиту назву бази в записі `typeorm_metadata` замінено на `current_database()`. `down()` знімає
індекси, FK і таблиці. Повторний `npm run migrate:generate -- src/migrations/Drift` каже «No changes».

Первинні ключі — `GENERATED BY DEFAULT AS IDENTITY` (у ДЗ #12 було `ALWAYS`): seed вставляє рядки з
фіксованими id, щоб `upsert` по id був ідемпотентним, і наприкінці підтягує послідовності через `setval`.
Гроші — integer у копійках; `orders.total_cents` — `bigint`, тому в entity це `string`.

### Підключення

`src/data-source.ts` не містить хоста чи пароля і не читає env-файлів: `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME` беруться з `process.env` і валідуються zod-схемою `src/config/db-env.schema.ts`
(це єдине місце поза `ConfigService`, де читається `process.env`, — CLI TypeORM працює без Nest).
Оточення наповнює `scripts/with-secrets.sh <env> <команда>`: з Infisical (`infisical run`), якщо є
`.secrets/infisical.env`, інакше — зі сховища ДЗ #11: хост, порт і база з `DB_URL` у локальному `.env`,
користувач і пароль з файла-секрета `DB_PASSWORD_FILE`. Гілку Infisical не перевірено — проєкту в Infisical
немає. `SKIP_VAULT=1` пропускає сховище: значення вже в оточенні (CI, грейдер).

Міграції виконує та сама роль, що й застосунок. `db/init.sql` задає ролям `marketplace_a`/`marketplace_b`
`SET role = 'marketplace'`, тому всі обʼєкти, включно з таблицею `migrations`, належать груповій ролі
й ротація з ДЗ #11 не ламає доступ.

### onDelete

| FK | Стратегія | Чому |
| --- | --- | --- |
| `order_items.order_id → orders` | `CASCADE` | позиції не існують без замовлення, це частина агрегата |
| `order_items.product_id → products` | `RESTRICT` | проданий товар не можна видалити — історію захищено; товар архівують через `status` |
| `orders.user_id → users` | `RESTRICT` | замовлення — фінансова історія, користувача з замовленнями не видаляють |
| `products.seller_id → users` | `RESTRICT` | каталог не зникає разом із продавцем мовчки |

`order_items` — явна join-entity для M:N «замовлення—товари» з даними на звʼязку (`quantity`,
`unit_price_cents` — ціна на момент покупки), а не `@ManyToMany`.

### N+1

`npm run demo:nplus1` — список замовлень із позиціями й товарами (`order → items → product`), лічильник —
власний `Logger` з `logging: ['query']`. Числа з seed:

| Стратегія | N = 5 | N = 10 |
| --- | --- | --- |
| наївно (запит у циклі) | 15 | 30 |
| `relations` (JOIN) | 2 | 2 |
| `relationLoadStrategy: 'query'` | 4 | 4 |

Наївний варіант росте разом із вибіркою (1 + N + кількість позицій), обидва фікси — константа. `relations`
дає 2, а не 1, бо список пагінований через `take`: для JOIN з `take` TypeORM спершу окремим запитом вибирає
`DISTINCT` id сторінки, потім одним JOIN тягне дані; без `take` той самий виклик — рівно 1 запит.

### Repository чи QueryBuilder

Repository (`find`, `relations`, `upsert`) — коли результат є entity або графом entities: CRUD, списки зі
звʼязками, seed. QueryBuilder — коли результат не є entity: агрегати, `GROUP BY`, обчислювані колонки,
звіти. `npm run report` («виторг по продавцях»: `JOIN` трьох таблиць, `SUM`, `COUNT(DISTINCT)`, `GROUP BY`)
через `find()` виразити неможливо, тому це `createQueryBuilder().getRawMany()`; агрегати приходять рядками
і не приводяться до `number` без перевірки діапазону.

### Seed

Ідемпотентність — кількість рядків після другого запуску не змінюється (10 / 12 / 10 / 19):

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -Atc "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items);"
```

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=marketplace_a DB_PASSWORD=marketplace_dev DB_NAME=marketplace
export SKIP_VAULT=1
```

Дев-роль `marketplace_a` / `marketplace_dev` створює `db/init.sql` при першому старті тому; секретом вона
не є. Далі — команди з acceptance criteria: `npm ci && npx tsc --noEmit`, `npm run build`, `npm run migrate`,
`npm run migrate:show`, `npm run migrate:revert`, `npm run seed && npm run seed`, `npm run demo:nplus1`,
`npm run report`. Міграції застосовуються на чисту базу: якщо в томі лишилась схема з `db/schema.sql`, спершу `docker compose down -v`.

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
