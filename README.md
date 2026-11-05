# Marketplace API

ДЗ №1 (hw-09):

**Обраний варіант contract-частини: А (consumer-driven Pact).** Консюмер `marketplace-web`
у `test/contract/consumer.pact-spec.ts` декларує очікування до `GET /orders/{id}` і `POST /orders`, «код фронта»
(`test/contract/orders-client.ts`) ганяється проти mock-провайдера, контракт пишеться у
`pacts/marketplace-web-marketplace-api.json`. З ДЗ #16 цей контракт ще й верифікується проти справжнього
застосунку (розділ «Тестування»).

Сам сервер — NestJS, дані в Postgres через TypeORM-репозиторії (`src/entities/`, ДЗ #13); на кордоні стоїть
`express-openapi-validator` (запити й відповіді звіряються зі спекою, помилки віддаються як
`application/problem+json`). Події домену йдуть у RabbitMQ через transactional outbox (ДЗ #19 і #22, розділи
«Async-події через RabbitMQ» та «Outbox та ідемпотентність»); Redis дає кеш, сесії, ліміти і чергу BullMQ
(ДЗ #23, розділ «Redis: кеш, сесії, ліміти, черга»); доступ закритий ES256-токенами з ротацією refresh і
RBAC (ДЗ #24, розділ «Auth»).

## Вимоги

Node.js ≥ 22.12.0, Docker з Compose (для Postgres, RabbitMQ, двох Redis, образу й тестів на testcontainers).

## Запуск

```bash
npm install
cp .env.example .env
node scripts/jwt-keys.mjs >> .env
cp secrets/db_password.example secrets/db_password
npm run db:up
npm run build && npm run migrate && npm run events:topology && npm run storage:init && npm run seed
npm start
```

Сервер слухає `http://localhost:3000` (`npm start` — голий запуск, значення з `.env`; `npm run start:vault` —
той самий запуск через обгортку сховища); relay outbox-у працює всередині нього (`npm run relay` — той самий relay
окремим процесом, для демо). Споживач подій `order.placed` — окремий процес, у другому терміналі (він же
оголошує топологію брокера при старті, тож `events:topology` потрібен лише щоб API стартував раніше за
споживача):

```bash
npm run consume
```

Воркер черги BullMQ (листи-підтвердження, перегрів кешу за планувальником) — ще один процес:

```bash
npm run worker
```

Кеш-шар перед сховищем для публічних ассетів (локальна форма CDN з ДЗ #26, порт `EDGE_PORT`, дефолт `3200`):

```bash
npm run edge
```

Порт API задається змінною `PORT`:

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
| `DB_URL` | так | — | URL **PgBouncer** (не Postgres напряму) **без облікових даних**, напр. `postgres://localhost:6432/marketplace` | сховище: локальний `.env` поза git (dev), env оточення платформи (prod) |
| `DB_PASSWORD_FILE` | так | — | шлях до файла-секрета формату `user:password`, напр. `secrets/db_password` | сховище: файл-секрет поза git, ротується `rotate.sh`; шаблон — `secrets/db_password.example` |
| `BROKER_URL` | так | — | AMQP-URL RabbitMQ **з обліковими даними**, напр. `amqp://marketplace:marketplace_dev@localhost:5672`; читають API (публікація `order.placed`), споживач і демо ДЗ #19 | сховище: локальний `.env` поза git (dev), env оточення платформи (prod); у `.env.example` — дев-користувач стенда, він не секрет |
| `REDIS_URL` | так | — | кеш-інстанс Redis (`allkeys-lru`), напр. `redis://localhost:6379`; картки товарів і локи | сховище: локальний `.env` поза git (dev), env оточення платформи (prod) |
| `REDIS_QUEUE_URL` | так | — | Redis під стан (`noeviction` + AOF), напр. `redis://localhost:6382`; черга BullMQ, сесії, лічильники ліміту | сховище: те саме |
| `RATE_LIMIT` | ні | `100` | скільки запитів клієнта пропускає ковзне вікно | `.env` (dev) / env оточення (prod) |
| `RATE_LIMIT_WINDOW_MS` | ні | `10000` | довжина ковзного вікна ліміту, мс | `.env` (dev) / env оточення (prod) |
| `JWT_KID` | так | — | `kid` ключа підпису access-токенів (ДЗ #24); має бути серед `JWT_PUBLIC_KEYS` | сховище: локальний `.env` поза git (dev), env оточення платформи (prod) |
| `JWT_PRIVATE_KEY` | так | — | base64 від PEM PKCS#8 приватного ключа ES256 | сховище: те саме; дев-пару генерує `node scripts/jwt-keys.mjs >> .env` |
| `JWT_PUBLIC_KEYS` | так | — | keyring для перевірки підпису: `kid:base64` від PEM SPKI через кому, напр. `2026-11:MFkw…,2026-05:MFkw…`; під час ротації — старий і новий ключ разом | сховище: те саме |
| `REFRESH_TOKEN_PEPPER` | так | — | HMAC-«перець» для хешів refresh-токенів, ≥ 16 байт | сховище: те саме |
| `STORAGE_ENDPOINT` | ні | — (порожньо = AWS S3) | адреса S3-сумісного сховища, напр. `http://localhost:9000` (MinIO зі стенда); задана → `forcePathStyle` | `.env` (dev) / env оточення (prod) |
| `STORAGE_REGION` | ні | `us-east-1` | регіон для підпису SigV4 (MinIO байдуже, AWS потребує регіон бакета) | `.env` (dev) / env оточення (prod) |
| `STORAGE_ACCESS_KEY` | так | — | ключ доступу до сховища (ДЗ #26) | сховище: локальний `.env` поза git (dev), env оточення платформи (prod); у `.env.example` — дев-користувач MinIO зі стенда, він не секрет |
| `STORAGE_SECRET_KEY` | так | — | секрет ключа доступу; право читати й писати **всі** файли бакета | сховище: те саме |
| `STORAGE_BUCKET` | так | — | приватний бакет для завантажень і хешованих публічних ассетів, напр. `marketplace-files`; створює `npm run storage:init` | `.env` (dev) / env оточення (prod) |
| `PACT_BROKER_URL` | ні | — | адреса Pact Broker для контрактних тестів (`http://127.0.0.1:9292` для compose); застосунок її не використовує, читає лише тестовий код | сховище: локальний `.env` поза git (dev), secrets GitHub (CI) |
| `PACT_BROKER_TOKEN` | ні | — | bearer-токен брокера; для локального compose-брокера порожній | сховище: локальний `.env` поза git (dev), secrets GitHub (CI) |

Контракт змінних — `.env.example` (у git). Реальний `.env` і тека `secrets/` — у `.gitignore`
та `.dockerignore`, у docker-образ вони не потрапляють.

На відміну від `DB_URL`, `BROKER_URL` несе облікові дані в собі: amqplib бере їх з URL, ротації без рестарту
для брокера не вимагалось, а значення живе лише у сховищі — у git є тільки `.env.example` із дев-користувачем
compose (`marketplace` / `marketplace_dev`), таким самим «не секретом», як `marketplace_a` / `marketplace_dev`
у `secrets/db_password.example`.

Облікові дані БД застосунок читає не з env, а з файла `DB_PASSWORD_FILE` у форматі `user:password`:
пул `pg.Pool` створює зʼєднання через власний `Client`, який перечитує файл на кожне нове зʼєднання.
Тому і користувача, і пароль можна ротувати без рестарту.

Стенд для локального запуску — `docker-compose.yml`: Postgres (порт хоста `5433` — лише для прямого
адмін-доступу), PgBouncer перед ним (порт хоста `6432` — сюди ходить застосунок, див. «Data layer ops»),
Pact Broker (`9292`, див. «Тестування»), RabbitMQ 4.2 (`5672` — AMQP, `15672` — вебморда менеджменту; healthcheck
— `rabbitmq-diagnostics -q check_running`, бо між відкриттям TCP-порту і готовністю Erlang-ноди приймати
`basic.publish` є вікно, у якому клієнт ловить `ECONNRESET`) і два Redis 8 — `redis-cache` (`6379`,
`allkeys-lru`) та `redis-queue` (`6382`, `noeviction` + AOF; див. «Redis: кеш, сесії, ліміти, черга»).
`npm run db:up` чекає на healthcheck усіх сервісів,
тож `npm run db:up && npm start` не стартує раніше за готовність стенда. `db/init.sql` створює дві рівноправні login-ролі `marketplace_a`
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
   `інша_роль:новий_пароль` → закриває зʼєднання попередньої ролі: клієнтські — на PgBouncer
   (`SHOW CLIENTS` + `KILL_CLIENT` через адмін-консоль), серверні — у Postgres (`pg_terminate_backend`).
   Поточна роль під час ротації не змінюється, тому вікна зі старим паролем немає. Без кроку на пулері
   клієнти попередньої ролі лишались би жити в PgBouncer і впали б при наступній ротації, коли їхній
   пароль зміниться, а пулеру знадобиться нове серверне зʼєднання.
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
| `/orders` | `GET /orders` (cursor-пагінація), `POST /orders` (Idempotency-Key), `GET /orders/{id}`, `PATCH /orders/{id}/status` (життєвий цикл), `GET /orders/{id}/events` (SSE) |
| `/sessions` | `POST /sessions` (сесія в Redis для `sub` токена), `GET /sessions/me` (`X-Session-Id`, читання подовжує TTL) — ДЗ #23 |
| `/auth` | `POST /auth/login`, `POST /auth/refresh` (ротація з детекцією повтору), `POST /auth/logout` — ДЗ #24; усі операції, крім `/health`, `GET /products*` і `login`/`refresh`, під `bearerAuth` |
| `/uploads`, `/files` | `POST /uploads/intent` (Idempotency-Key, presigned PUT або multipart-план), `GET /uploads/{id}/parts` (ListParts + URL лише на відсутні частини), `POST /uploads/{id}/commit` (HeadObject, звірка розміру), `GET /files/{id}` → `302` на presigned GET на 60 с — ДЗ #26 |

- **Cursor-пагінація**: `?limit=&cursor=`, відповідь `{ items, next_cursor }`, `next_cursor: null` — сторінок більше немає. Курсор — непрозорий токен.
- **Idempotency-Key**: обовʼязковий header на POST, що створюють ресурс (`/products`, `/orders`, `/uploads/intent`). Той самий ключ + те саме тіло → та сама відповідь `201` + `Idempotency-Replay: true`; той самий ключ + інше тіло → `422`. Ключі живуть у таблиці `idempotency_keys` в одній транзакції з ресурсом (ДЗ #22).
- **problem+json**: кожна помилка — `application/problem+json` зі схемою `Problem` (`type`, `title`, `status`, `detail`, `instance`).
- Гроші — цілі копійки (`price_cents`, `total_cents`).
- **Checkout** (`POST /orders`) — одна транзакція: атомарний декремент `stock` кожного товару, списання
  `balance_cents` покупця, `orders` + `order_items` + задача на post-processing у черзі `tasks`; замовлення
  створюється зі статусом `paid`. Бракує товару або коштів → `409` problem+json і повний відкат
  (див. «Конкурентність»).
- Авторизації поки немає, тому власника вказує клієнт: `POST /products` вимагає `seller_id`, `POST /orders` — `user_id`
  (обидва — існуючі `users.id`, інакше `404`).

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
`db/schema.sql` і `db/seed.sql` лишаються артефактами ДЗ #12 для циклу EXPLAIN і не оновлюються слідом за
міграціями (у них немає `stock`, `balance_cents`, `tasks`); джерело правди для застосунку — міграції.

HTTP-шар (`src/products`, `src/orders`, `/health`) працює з цими самими entities через `TypeOrmModule`
і репозиторії; `DbModule` віддає TypeORM той самий `pg.Client`, що перечитує файл-секрет на кожне нове
зʼєднання, тож ротація з ДЗ #11 працює і для ORM-пулу. Оформлення замовлення — транзакція
`src/checkout/checkout.ts` (декремент stock, списання балансу, `orders` + `order_items` + задача в черзі;
деталі — у «Конкурентність»). Entities повертають
`bigint` рядками, тому на кордоні вони мапляться в DTO контракту (`id`, `total_cents` — числа).

Команди (усі, що ходять у базу, загорнуті в `scripts/with-secrets.sh dev`):

```bash
npm run build
npm run migrate          # застосувати міграції
npm run migrate:show     # [X] — застосовані
npm run migrate:revert   # відкотити останню
npm run seed             # детермінований ідемпотентний seed
npm run demo:nplus1      # N+1 «до/після»
npm run report           # виторг по продавцях через QueryBuilder
npm run check:indexes    # індекси з synchronize: false існують у базі
npm run demo:race        # 50 паралельних checkout на stock = 10 — без oversell
npm run demo:workers     # воркер-пул через FOR UPDATE SKIP LOCKED
npm run demo:retry       # retry транзакції на 40001/40P01
```

Початкову міграцію згенеровано через `migration:generate`, прочитано й поправлено руками: додано чотири
індекси з ДЗ #12, яких декоратори TypeORM не вміють виразити (`DESC`, partial з `INCLUDE`, expression
`lower(email)`, GIN) — в entities вони позначені `@Index(..., { synchronize: false })`, тож генератор їх не
чіпає; зашиту назву бази в записі `typeorm_metadata` замінено на `current_database()`. `down()` знімає
індекси, FK і таблиці. Повторний `npm run migrate:generate -- src/migrations/Drift` каже «No changes».

Зворотний бік `synchronize: false` на індексі: генератор не помітить, якщо такий індекс зникне з бази.
Тому `npm run check:indexes` звіряє всі індекси entities з `synchronize: false` проти `pg_indexes`: не
лише наявність за іменем, а й визначення (`indexdef` у канонічній формі Postgres — колонки, `DESC`,
`INCLUDE`, `WHERE`, метод доступу) з еталоном у `src/check-indexes.ts`; падає з exit 1, назвавши
відсутні (`MISSING`), змінені (`DIFFERS`, з очікуваним і фактичним визначенням) або незадекларовані
(`NO SPEC` / `ORPHAN`). Він виконується у CI (`.github/workflows/ci.yml`, job `db`: `docker compose up -d --wait` → міграції
крізь PgBouncer → `check:indexes` → seed двічі → три демо конкурентності → бекап → restore-drill → lint спеки;
jobs `tests` і `contract` описані в «Тестування»). Сам workflow локально не запускався.

Первинні ключі — `GENERATED BY DEFAULT AS IDENTITY` (у ДЗ #12 було `ALWAYS`): seed вставляє рядки з
фіксованими id, щоб `upsert` по id був ідемпотентним, і наприкінці підтягує послідовності через `setval`.
Гроші — integer у копійках; `orders.total_cents` — `bigint`, тому в entity це `string`.

### Підключення

`src/data-source.ts` не містить хоста чи пароля і не читає env-файлів: `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME` беруться з `process.env` і валідуються zod-схемою `src/config/db-env.schema.ts`
(поза `ConfigService` `process.env` читають лише скрипти без Nest: CLI TypeORM через цю схему, споживач і
демо ДЗ #19 — через `parseBrokerUrl` із `src/config/env.schema.ts` для `BROKER_URL`).
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
| `order_events.order_id → orders` | `CASCADE` | історія статусів — частина того самого агрегата (ДЗ #18) |
| `shipments.order_id → orders` | `CASCADE` | відправлення — наслідок замовлення, без нього не існує (ДЗ #19) |
| `order_items.product_id → products` | `RESTRICT` | проданий товар не можна видалити — історію захищено; товар архівують через `status` |
| `orders.user_id → users` | `RESTRICT` | замовлення — фінансова історія, користувача з замовленнями не видаляють |
| `products.seller_id → users` | `RESTRICT` | каталог не зникає разом із продавцем мовчки |

`outbox`, `processed_messages` і `idempotency_keys` (ДЗ #22) зовнішніх ключів не мають свідомо: outbox-рядок —
це вже відправлена назовні подія, inbox-позначка і ключ API-краю мають пережити видалення того, на що
посилаються, інакше повтор доставки чи запиту після видалення знову застосує ефект.

`order_items` — явна join-entity для M:N «замовлення—товари» з даними на звʼязку (`quantity`,
`unit_price_cents` — ціна на момент покупки), а не `@ManyToMany`.

### N+1

`npm run demo:nplus1` — список замовлень із позиціями й товарами (`order → items → product`), лічильник —
власний `Logger` з `logging: ['query']`. Розміри вибірки — аргументи (`npm run demo:nplus1 -- 5 10 100`),
за замовчуванням 5 і 10; колонка `orders fetched (N)` показує, скільки замовлень реально повернулось, якщо
таблиця менша за `take`. Числа з seed (10 замовлень):

| Стратегія | N = 5 | N = 10 |
| --- | --- | --- |
| наївно (запит у циклі) | 15 | 30 |
| `relations` (JOIN) | 2 | 2 |
| `relationLoadStrategy: 'query'` | 4 | 4 |

Ті самі стратегії на даних ДЗ #12 (`db/seed.sql` поверх міграцій, 300 000 замовлень, 1–3 позиції в кожному):

| Стратегія | N = 5 | N = 10 | N = 100 | N = 1000 |
| --- | --- | --- | --- | --- |
| наївно (запит у циклі) | 26 | 50 | 321 | 3021 |
| `relations` (JOIN) | 2 | 2 | 2 | 2 |
| `relationLoadStrategy: 'query'` | 4 | 4 | 4 | 4 |

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

Ідемпотентність — кількість рядків після другого запуску не змінюється (10 / 12 / 10 / 19). Seed робить
`upsert` по фіксованих id, тому повторний запуск також повертає `stock` і `balance_cents` до seed-значень
(зручно, щоб «обнулити» стан після демо; для продакшн-даних такий seed не призначений):

```bash
docker compose exec -T postgres psql -U postgres -d marketplace -Atc "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items);"
```

## Конкурентність

Ключова операція домену — оформлення замовлення, `src/checkout/checkout.ts`. Вона спільна для HTTP
(`POST /orders`) і навантажувального демо й виконується в одній транзакції `dataSource.transaction`
(усі statements ідуть через один клієнт пулу):

1. для кожного товару, у порядку зростання `id`:
   `UPDATE products SET stock = stock - $n WHERE id = $id AND stock >= $n RETURNING price_cents`;
   0 рядків → `INSUFFICIENT_STOCK` (або `PRODUCT_NOT_FOUND`), транзакція відкочується;
2. `UPDATE users SET balance_cents = balance_cents - $total WHERE id = $u AND balance_cents >= $total RETURNING id`;
   0 рядків → `INSUFFICIENT_FUNDS`;
3. `INSERT` у `orders`, `order_items`, задача `order_confirmation` у `tasks` і рядок `outbox` з подією
   `order.placed` (ДЗ #22).

Будь-яка помилка до `COMMIT` відкочує все разом: замовлень-«сиріт», списаних без замовлення коштів чи
зарезервованого без замовлення товару не буває. Блокування беруться в одному й тому самому порядку
(товари за `id`, потім користувач), тому два checkout з різними наборами товарів не можуть заблокувати
один одного навхрест.

**Чому атомарний UPDATE, а не `SELECT … FOR UPDATE`.** Обидва коректні, але `UPDATE … WHERE stock >= $n
RETURNING` робить перевірку, блокування й запис одним statement: рядок береться під лок, конкурентний
UPDATE чекає на ньому, а після `COMMIT` першого Postgres переоцінює `WHERE` на новій версії рядка
(EvalPlanQual) — тож вікна між «прочитав 10» і «записав 9» просто не існує, і один round-trip до бази
замість двох. `FOR UPDATE` потрібен, коли між читанням і записом має відбутись бізнес-логіка на стороні
застосунку (порахувати знижку з кількох таблиць, викликати зовнішній сервіс) — тут її немає, тому
песимістичний лок був би дорожчим варіантом того самого захисту. Обмеження `CHECK (stock >= 0)` і
`CHECK (balance_cents >= 0)` у схемі — страховка на випадок, якщо хтось напише інший UPDATE без умови.

`npm run demo:race`: 50 `Promise.all`-викликів `checkout` на товар `1` зі `stock = 10`, по одній одиниці,
покупці — 10 seed-користувачів із балансом 1 000 000 грн (обмежує саме stock). Пул застосунку на 55 зʼєднань, щоб усі 50 транзакцій стартували
одночасно; з ДЗ #15 вони йдуть через PgBouncer, який мультиплексує їх на 10 серверних зʼєднань
(`default_pool_size`), тож одночасно в Postgres виконується до 10 транзакцій, решта чекає в черзі пулера —
інваріант і числа від цього не змінюються. Числа з запуску:

| Метрика | Значення |
| --- | --- |
| спроб | 50 |
| успішних | 10 |
| відхилено `INSUFFICIENT_STOCK` | 40 |
| фінальний `stock` | 0 |
| рядків зі `stock < 0` | 0 |
| створено замовлень | 10 |
| час | ≈170 ms |

Скрипт сам перевіряє інваріант і завершується з exit 1, якщо успішних ≠ 10, stock ≠ 0, є відʼємний stock
або кількість замовлень не дорівнює кількості успіхів.

### Воркер-пул через SKIP LOCKED

Черга — таблиця `tasks` (міграції `StockBalanceTasks` і `TaskAttempts`): `type`, `payload jsonb`, `status`
(`pending` / `done` / `failed`), `processed`, `attempts`, `last_error`, `worker`, `processed_at`, індекс
`(status, id)`. Воркер (`src/tasks/worker.ts`) у циклі відкриває транзакцію, бере одну задачу
`SELECT … WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED` і обробляє її **всередині
цієї ж транзакції**:

- обробник виконується у вкладеній транзакції (`SAVEPOINT`) і отримує її `EntityManager`, тож його записи
  комітяться разом зі `status = 'done', processed = processed + 1, attempts = attempts + 1`;
- виняток обробника відкочує лише savepoint: лок на задачі лишається, воркер у тій самій транзакції
  записує `attempts + 1` і `last_error`, а після `maxAttempts` (за замовчуванням 3) спроб ставить
  `status = 'failed'`. Задача з винятком більше не вбиває воркер і не вертається в `pending` вічно;
- якщо впаде сам процес воркера до `COMMIT`, лок зникне і задачу підбере інший.

Порожня відповідь `SKIP LOCKED` означає «вільних зараз немає», а не «черга порожня», тому воркер перепитує
`count(*) WHERE status = 'pending'` і завершується лише коли він 0. Обмеження: між спробами немає
затримки (невдала задача одразу знову доступна), а падіння процесу спробою не рахується.

`npm run demo:workers`: 4 воркери в одному процесі, обробка задачі — 50 ms. У чергу додаються 40 звичайних
задач, 1 «flaky» (падає на першій спробі, проходить на другій) і 2 «poison» (падають завжди), плюс
розбирається все, що вже лежить у `pending` (після `demo:race` — 10 задач `order_confirmation`). Інваріант
рахується по **всіх** задачах, яких торкнулися воркери, а не лише по доданих цим запуском: кожна або
`done` з `processed = 1`, або `failed` рівно після 3 спроб, жодна не лишилась `pending`, і це ті самі
задачі, що в розподілі й у базовому часі. Числа з запуску на чистій базі одразу після `demo:race`:

| Метрика | Значення |
| --- | --- |
| задач зачеплено | 53 (43 свої + 10 з `demo:race`) |
| done | 51 |
| failed після 3 спроб | 2 |
| спроб обробника | 58 (5 повторних) |
| розподіл done | worker-1 = 14, worker-2 = 12, worker-3 = 13, worker-4 = 12 |
| оброблено двічі | 0 |
| час | 942 ms проти 2 900 ms послідовно (58 спроб × 50 ms) |

### Retry на serialization failure

`src/common/retry.ts` — `withRetry(fn)`: повторює **всю** транзакцію з початку, включно з читаннями, з
експоненційним backoff і джитером, логуючи кожен повтор. Повторюються лише два SQLSTATE: `40001`
(`serialization_failure`) і `40P01` (`deadlock_detected`). Це єдині помилки, якими Postgres каже
«транзакція коректна, просто програла конкуренту — спробуй ще раз», і повтор має шанс пройти. Усе інше
або детерміноване (порушення CHECK/UNIQUE, помилка синтаксису, `NOT FOUND` бізнес-логіки — повтор дасть
той самий результат), або лишає стан невідомим (обрив зʼєднання: `COMMIT` міг пройти, і повтор
подвоїть ефект). Повтор лише запису замість усієї транзакції — той самий lost update у профіль, бо
прочитане значення вже застаріло.

`npm run demo:retry`: 10 конкурентних транзакцій під `REPEATABLE READ` роблять read-modify-write балансу
користувача `1` (+100 копійок кожна) з `pg_sleep` між читанням і записом, щоб конфлікт був гарантований.
Числа з запуску: 39 повторів, усі `40001`; фінальний баланс = початковий + 1 000, перевіряється скриптом.
Це навмисно «неправильний» патерн, щоб спровокувати помилку: у продакшн-коді для такого достатньо
атомарного `UPDATE … SET balance_cents = balance_cents + 100`, як у checkout; retry потрібен там, де
логіка справді мусить спершу прочитати.

## Data layer ops

```
застосунок / міграції / демо ──► PgBouncer :6432 (transaction pooling) ──► Postgres :5432
бекап, ротація, psql адміністратора ────────────────────────────────────► Postgres (напряму)
```

### Як підняти

```bash
docker compose up -d --wait
```

Піднімає Postgres 17, PgBouncer 1.26 (`edoburu/pgbouncer`), Pact Broker і RabbitMQ 4.2, чекає healthcheck усіх
чотирьох. Healthcheck пулера —
справжній запит `SELECT 1` крізь PgBouncer у базу, тож «healthy» означає, що шлях до Postgres працює.
Порти хоста: `6432` — PgBouncer (сюди вказують `DB_URL` у `.env.example` і `DB_PORT` у «Grading»),
`5433` — Postgres напряму, лише для адміністратора.

Конфіг пулера — `pgbouncer/pgbouncer.ini`:

| Параметр | Значення | Навіщо |
| --- | --- | --- |
| `pool_mode` | `transaction` | серверне зʼєднання займається лише на час транзакції |
| `default_pool_size` | `10` | стільки серверних зʼєднань на пару база/роль |
| `max_client_conn` | `200` | стільки клієнтів приймає пулер; зайві чекають у черзі, а не в Postgres |
| `max_prepared_statements` | `200` | protocol-level prepared statements працюють у transaction mode (PgBouncer ≥ 1.21) |
| `auth_type` / `auth_query` | `scram-sha-256` / `pgbouncer.get_auth($1)` | див. нижче |
| `admin_users` | `pgbouncer_admin` | адмін-консоль |

Автентифікація: у `pgbouncer/userlist.txt` лежать лише два дев-акаунти самого пулера (`pgbouncer` —
службова роль для `auth_query`, `pgbouncer_admin` — консоль). SCRAM-верифікатори ролей застосунку пулер
бере з Postgres через `SECURITY DEFINER`-функцію `pgbouncer.get_auth` (роль, схему й функцію створює
`db/init.sql`). Тому паролі застосунку не дублюються в конфігу пулера, і ротація з ДЗ #11 не потребує його
правки. Том, створений до ДЗ #15, цієї ролі не має: `docker compose down -v` або виконайте хвіст `db/init.sql`.

Перевірки (пароль ролі застосунку після `rotate.sh` — у `secrets/db_password`; без `psql` на хості ті самі
команди працюють як `docker compose exec -T pgbouncer psql …`):

```bash
psql "postgres://marketplace_a:marketplace_dev@127.0.0.1:6432/marketplace" -c "SELECT 1"
```

```bash
psql "postgres://pgbouncer_admin:pgbouncer_admin_dev@127.0.0.1:6432/pgbouncer" -c "SHOW POOLS"
```

### Чому transaction mode і що він ламає

Бекенд Postgres — окремий процес із власною памʼяттю, а `max_connections` — 100. Застосунок тримає пул
зʼєднань на кожен інстанс, і з ростом числа інстансів (ДЗ #28) прямі зʼєднання закінчаться раніше за CPU.
У transaction mode серверне зʼєднання належить клієнту лише від `BEGIN` до `COMMIT`, тож 200 клієнтів
ділять 10 бекендів: `demo:race` відкриває 50 клієнтських зʼєднань, а в Postgres їх при цьому рівно 10.
Session mode такого мультиплексування не дає (клієнт тримає бекенд увесь час), statement mode ламає
багатооператорні транзакції, тобто checkout.

Ціна — усе, що живе довше за транзакцію, бо наступна транзакція клієнта може піти іншим бекендом:

1. **Session-level `SET`** (`SET search_path`, `SET ROLE`, `SET statement_timeout`): налаштування лишається на
   бекенді й дістається чужому клієнту. Заміна — `SET LOCAL` у транзакції або `ALTER ROLE … SET`; саме так
   ролям `marketplace_a`/`_b` задано `role = marketplace`, і це працює крізь пулер.
2. **Session advisory locks** (`pg_advisory_lock`): лок і його зняття можуть потрапити на різні бекенди.
   Заміна — `pg_advisory_xact_lock`.
3. **`LISTEN` / `NOTIFY`**: підписка привʼязана до сесії, якої в клієнта більше немає.
4. **SQL-рівневі `PREPARE` / `EXECUTE`, тимчасові таблиці, `WITH HOLD`-курсори**: обʼєкт створено на одному
   бекенді, а звернення приходить на інший.
5. **`pg_dump` та інші сесійні інструменти**: `pg_dump` на початку робить session-level `SET`
   (зокрема порожній `search_path`), який у transaction mode лишився б на бекенді з пулу й ламав запити
   застосунку. Тому бекап іде в Postgres напряму.

У цьому проєкті checkout, воркер (`FOR UPDATE SKIP LOCKED`) і retry (`REPEATABLE READ`) живуть кожен в одній
транзакції, TypeORM не використовує іменованих prepared statements, тож усі команди ДЗ #13–14 проходять крізь
пулер без змін коду. Змінити довелось ротацію: `rotate.sh` тепер закриває клієнтів попередньої ролі ще й на
пулері (див. «Ротація пароля БД без рестарту»).

### Бекап

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
```

Або `npm run backup`. Скрипт бере всі пʼять `DB_*` з оточення, яке наповнює обгортка зі сховища ДЗ #11.
Спершу він підключається до `DB_HOST:DB_PORT` (тобто до PgBouncer) так, як цю адресу бачить хост, з
`DB_USER`/`DB_PASSWORD`, і читає ідентифікатор кластера (`pg_control_system()`); те саме питає в сервісу
`postgres` напряму й порівнює. Недосяжна адреса, хибний пароль або інший кластер за цією адресою —
exit 1 без дампа, тож бекап не може мовчки зняти не ту базу, на яку вказує сховище. Лише після цього
`pg_dump -Fc` запускається всередині контейнера Postgres (версія клієнта завжди збігається із сервером)
і йде в Postgres напряму по TCP з перевіркою пароля, повз пулер. Результат —
`backups/<база>_<РРРР-ММ-ДД_ГГММСС>.dump` у теці на хості поза контейнером (у `.gitignore` і
`.dockerignore`); шлях друкується останнім рядком у stdout.

Поруч лягає `<дамп>.control` — контрольні значення: кількість таблиць, кількість рядків кожної таблиці та
`count` + `sum(total_cents)` по ключовій таблиці `orders` (`scripts/backup-control.sql`). Вони знімаються
**в тому самому снапшоті**, що й дамп: скрипт відкриває `REPEATABLE READ`-транзакцію, експортує снапшот
(`pg_export_snapshot`), передає його в `pg_dump --snapshot` і в ній же рахує контрольні значення. Тому
запис у базу під час бекапу не дає хибного `MISMATCH`. Архів перевіряється `pg_restore --list` до того, як
файл зʼявиться під фінальним іменем. Дампи, старші за 7 діб (`BACKUP_RETENTION_DAYS`), видаляються; теку
можна змінити через `BACKUP_DIR`. Службова схема `pgbouncer` і ролі в дамп не входять — їх створює `db/init.sql`.

Перевірити архів:

```bash
docker compose exec -T postgres pg_restore --list < backups/<файл>.dump
```

Розклад — `backup.cron`: щоночі о 03:00 через ту саму обгортку, лог у `backups/backup.log`; другий рядок о 03:30 — `npm run prune` для таблиць ДЗ #22 (розділ «Outbox та ідемпотентність»). Рядок сам
створює теку `backups` (`mkdir -p`), бо редирект логу відкривається раніше, ніж стартує скрипт.

### Restore-drill

```bash
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

Або `npm run restore:drill`. Скрипт бере останній дамп із `backups/`, створює **новий** контейнер Postgres
з порожнім томом (`docker run`, той самий образ, що в compose), відновлює в нього дамп
(`pg_restore --no-owner --no-privileges --exit-on-error`), рахує ті самі контрольні значення й порівнює з
`.control`, знятим під час бекапу. Друкує час кожного кроку, обидва набори значень і `MATCH`; при
розбіжності — `MISMATCH` і exit 1. Контейнер і том видаляються в будь-якому разі, тож повторний запуск
починає з нуля. Робочий стек drill-у не потрібен і не зачіпається. Протокол прогону з RTO/RPO —
[RESTORE-DRILL.md](RESTORE-DRILL.md).

### Як відновитись

Після втрати тому — у новий кластер (перевірено: 8 с на базі 272 MB):

```bash
docker compose up -d --wait
docker compose exec -T postgres pg_restore -U postgres -d marketplace --exit-on-error < backups/<файл>.dump
docker compose exec -T postgres psql -U postgres -d marketplace -XqAt < scripts/backup-control.sql | diff - backups/<файл>.dump.control && echo MATCH
cp secrets/db_password.example secrets/db_password
```

`init.sql` нового кластера створює ролі зі стартовими паролями, тому файл-секрет повертається до стартового
значення; власники обʼєктів відновлюються з дампа (`marketplace`). Поверх наявної пошкодженої бази —
та сама команда `pg_restore` з `--clean --if-exists` (теж перевірено), файл-секрет при цьому не чіпати.

## Тестування

Драбинка довіри: integration проти справжнього Postgres → E2E повного застосунку → контракт Pact →
брокер і `can-i-deploy`. Потрібен лише запущений Docker: Postgres, RabbitMQ і Redis для тестів піднімає testcontainers, ES256-пару
для токенів генерує глобальний setup,
compose для перших чотирьох команд не потрібен.

| Команда | Що запускає | Результат прогону |
| --- | --- | --- |
| `npm run test:integration` | `test/integration/` — репозиторії, checkout, воркер, outbox і relay, споживач `order.placed`, кеш/сесії/ліміт/черга проти Postgres, RabbitMQ і Redis у testcontainers | 7 наборів, 33 тести |
| `npm run test:e2e` | `test/e2e/` — повний `AppModule` через supertest: замовлення, ключ ідемпотентності, realtime, relay `order.placed`, картка з кешу, сесії, `429`, auth (логін, логаут, детекція повтору, `401` ≠ `403`) | 19 тестів |
| `npm run test:contract` | `test/contract/consumer.pact-spec.ts` — consumer-тест, пише `pacts/*.json` | 3 interactions |
| `npm run verify:provider` | `test/contract/provider.pact-spec.ts` — справжній застосунок проти контракту | 3 × `has a matching body (OK)` |

### Як це влаштовано

- **Jest 30 + ts-jest**, конфіг — `jest.config.js`: `reporters: ['default']`, `maxWorkers: 1`, чотири проєкти
  (`--selectProjects`). Пакети Nest 12 — ESM-only, а Jest на Node < 24.9 не вміє `require()` для ESM, тому
  скрипти запускають Jest у ESM-режимі (`node --experimental-vm-modules`), і ts-jest компілює тести й `src/`
  як ES-модулі (`useESM`). Компілятор — той самий tsc, тож decorator-метадані на місці.
- **Контейнер** (`test/integration/testkit/global-setup.ts`): `PostgreSqlContainer` з образом
  `postgres:16-alpine`, як у завданні; стенд у `docker-compose.yml` працює на `postgres:17-alpine`, міграції
  проходять на обох версіях. Один контейнер на прогін; після старту на нього накочуються **справжні міграції**
  з `src/migrations/`, тож схема в тестах — та сама, що в базі застосунку.
- **Підключення** видає контейнер у рантаймі: `container.getConnectionUri()` → `TEST_DATABASE_URL` для
  тестових `DataSource`. Для повного застосунку той самий контейнер подається його штатним шляхом:
  `DB_URL` без облікових даних плюс тимчасовий файл-секрет `user:password` у `DB_PASSWORD_FILE`. Сховище
  ДЗ #11 у тестах не бере участі.
- **Запобіжник**: `resetDatabase()` відмовляється робити `TRUNCATE`, якщо `DataSource` дивиться не на
  тестовий контейнер, — на випадок, коли в оточенні лишився `DB_URL` дев-бази.

### Ізоляція

Стратегія — **один контейнер на прогін + `TRUNCATE … RESTART IDENTITY CASCADE` усіх таблиць перед кожним
тестом**. Транзакція з `ROLLBACK` сюди не підходить: checkout і воркер самі відкривають транзакції й
комітять, а тести гонки та `SKIP LOCKED` потребують кількох зʼєднань, які мають бачити закомічені дані
одне одного. Контейнер на файл дав би ту саму чистоту, але коштує 2–3 секунди старту на кожен файл, тоді як
`TRUNCATE` десяти малих таблиць — мілісекунди. Повторний запуск зелений без чистки: кожен прогін отримує
новий контейнер, а в межах прогону стан обнуляється перед кожним тестом. RabbitMQ — так само один контейнер
на прогін (глобальний setup оголошує в ньому топологію), а тести, що читають черги, роблять `purgeQueue`
робочої черги і DLQ перед кожним тестом.

### Test data builders

`test/integration/testkit/builders.ts`: `aUser()`, `aProduct()`, `anOrder()` повертають валідні обʼєкти з
унікальними дефолтами (email з лічильником і UUID), а `given(dataSource)` зберігає їх разом із
залежностями (`product()` сам створить продавця, `order()` — покупця й товар). Тест називає лише те, що для
нього важливе: `await product({ stock: 5 })`.

### Що покрито

| Файл | Чого не має мок |
| --- | --- |
| `users.repository.int-spec.ts` | unique на email (`23505`), `upsert` через `ON CONFLICT`, FK `RESTRICT` (`23503`), CHECK на баланс (`23514`) |
| `orders.repository.int-spec.ts` | завантаження графа через JOIN, `ON DELETE CASCADE`, unique `(order_id, product_id)`, FK `RESTRICT`, агрегат «виторг по продавцях» (`JOIN` + `GROUP BY`) |
| `checkout.int-spec.ts` | атомарність транзакції, повний відкат при нестачі коштів або товару, 20 конкурентних checkout на 5 одиниць без oversell |
| `tasks-worker.int-spec.ts` | `FOR UPDATE SKIP LOCKED` (рівно один раз на трьох воркерах), повтор, `failed` після ліміту спроб із відкатом savepoint |
| `order-placed-consumer.int-spec.ts` | справжній RabbitMQ: дубль події → один рядок `shipments` і одна позначка в `processed_messages`; ефект, що падає → три повтори через retry-чергу з паузою і DLQ з `rejected`; повідомлення поза контрактом → DLQ з `rejected` без повторів; crash-loop (`requeue` × 4) → DLQ з `delivery_limit` (ДЗ #19) |
| `outbox.int-spec.ts` | замовлення і рядок outbox одним COMMIT; падіння після вставки в outbox відкочує обидва; ключ ідемпотентності: replay, `422` на інше тіло, пʼять паралельних запитів з одним ключем → одне замовлення, невдалий запит ключа не лишає; relay публікує по порядку і позначає `published_at`; publish, що падає завжди → backoff, після пʼяти спроб подія в DLQ і `failed_at`; падіння relay між publish і UPDATE → подія вдруге, ефект один, inbox з однією позначкою (ДЗ #22) |
| `redis.int-spec.ts` | 30 одночасних промахів → один виклик loader-а, TTL із джитером, лок не знімає чужий токен, 25 промахів на відсутній id → один виклик і негативний кеш; сесія подовжує TTL на читанні; ліміт спільний для двох екземплярів і точний під 50 паралельними запитами; черга дедуплікує за `jobId` і доводить падучу задачу до `completed` за три спроби (ДЗ #23) |
| `test/e2e/redis.e2e-spec.ts` | картка товару з кешу з TTL 295–360 с, інвалідація після замовлення; `POST /sessions` → `GET /sessions/me` і будь-який запит із `X-Session-Id` подовжують TTL, `401` на невідомий id; `429` problem+json із `Retry-After` після ліміту, `/health` поза лімітом (ДЗ #23) |
| `test/e2e/files.e2e-spec.ts` | intent: ключ `uploads/{userId}/{uuid}.png` без слідів `filename`, replay за Idempotency-Key, `400` на тип поза allowlist; commit до байтів → `409`, підмінений ключ у presigned → `403`, PUT байтів → commit `200`, повторний commit `200`; `GET /files/{id}` → `302` і ті самі байти, чужому `403`, без токена `401`; розмір не збігся → `409`; multipart: 2 з 3 частин → `parts` бачить `[1,2]` і дає URL лише на `[3]`, HeadObject до complete — нічого, commit `409`, після третьої частини complete `200` з ETag `-3`; ассети: прямий GET у бакет `403`, edge `MISS` → `HIT` з `immutable`, новий вміст — нове імʼя (ДЗ #26) |
| `test/e2e/auth.e2e-spec.ts` | логін ES256 (`kid`, `alg`), `401` на пароль/без токена/зіпсований; keyring із двох `kid`: токен другого ключа проходить, невідомий `kid` — `401`; логаут як дві дії (`access_denylist` + сімʼя); повторне використання refresh валить сімʼю разом із чесним клієнтом; `401` ≠ `403` на власності, ролі, чужому `user_id`/`seller_id` і підробленому payload; список замовлень лише своїх, адмін бачить усі (ДЗ #24) |
| `test/e2e/orders.e2e-spec.ts` | створити товар → оформити замовлення → прочитати обидва → повтор з тим самим `Idempotency-Key`; `400` без ключа, `404` на невідоме замовлення, `409` при нестачі товару, `422` на той самий ключ з іншим тілом; relay усередині API виносить `order.placed` рівно один раз, повтор за ключем — не публікує (ДЗ #19, #22) |
| `test/e2e/realtime.e2e-spec.ts` | життєвий цикл статусів і `409`; SSE: `Last-Event-ID`, `400`/`403`/`404` для не-власника, нумерація після рестарту; WS: кімнати, `forbidden`/`unauthenticated` (ДЗ #18) |

E2E піднімає `Test.createTestingModule({ imports: [AppModule] })` без підмін провайдерів. Налаштування
застосунку (`express.json`, `express-openapi-validator` із валідацією запитів і відповідей) винесені в
`src/app.setup.ts` і викликаються і з `main.ts`, і з тестів, тож E2E перевіряє той самий застосунок, що
стартує в проді.

### Контракт

`npm run test:contract`: «фронтенд» `marketplace-web` (`test/contract/orders-client.ts`) описує три
interactions з provider states — `GET /orders/1` (`order 1 exists`), `GET /orders/999`
(`order 999 does not exist`, `404` problem+json) і `POST /orders`
(`user 1 has funds and product 2 is in stock`). Шляхи й форми відповідей відповідають `/orders/{id}` і
`/orders` зі спеки `openapi/openapi.yaml`. Файл `pacts/marketplace-web-marketplace-api.json` лежить у git;
тест генерує його заново детерміновано (CI теж генерує сам).

`npm run verify:provider` стартує справжній застосунок на базі з testcontainers і проганяє контракт.
`stateHandlers` сідять базу тим самим ідемпотентним `seedDatabase()` (`upsert` → `ON CONFLICT`), що й
`npm run seed`, тому верифікація повторювана. Сам Pact — CommonJS-пакет з ESM-only залежностями, тож він
вантажиться рідним `require` Node через `test/contract/native-require-environment.js`; там же вимкнена
анонімна телеметрія Pact (`PACT_DO_NOT_TRACK`).

Режим визначає оточення, у коді адреси й токена немає:

| Як запущено | Що відбувається |
| --- | --- |
| `npm run verify:provider` | `PACT_BROKER_URL` не задано → верифікується локальний `pacts/*.json`, нічого не публікується |
| `bash scripts/with-secrets.sh dev npm run verify:provider` | **основний шлях**: обгортка бере `PACT_BROKER_URL` / `PACT_BROKER_TOKEN` зі сховища ДЗ #11 (локальний `.env`), контракт береться з брокера, результат публікується (`publishVerificationResult: true`) |
| `PACT_BROKER_URL=http://127.0.0.1:9292 npm run verify:provider` | **аварійна форма для грейдера** без доступу до сховища; під `SKIP_VAULT=1` обгортка виконує рівно її |

Версія провайдера — `PACT_VERSION`, а якщо її немає — `git rev-parse --short HEAD`; поза git-чекаутом і без
`PACT_VERSION` і `verify:provider` у режимі брокера, і `scripts/pact-broker.sh` зупиняються з поясненням.

### Брокер локально і гейт can-i-deploy

Брокер — сервіс `pact-broker` у `docker-compose.yml` (порт `9292`, sqlite всередині контейнера, без
автентифікації; стан зникає разом із контейнером). Піднімається разом зі стендом:

```bash
docker compose up -d --wait
```

Гейт у роботі — спершу «не можна», потім «можна»:

```bash
export PACT_BROKER_URL=http://127.0.0.1:9292
VERSION=$(git rev-parse --short HEAD)
npm run test:contract
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H 'Content-Type: application/json' --data @pacts/marketplace-web-marketplace-api.json "$PACT_BROKER_URL/pacts/provider/marketplace-api/consumer/marketplace-web/version/$VERSION"
PACT_BROKER_URL=$PACT_BROKER_URL npm run verify:provider
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-web&version=$VERSION&to=prod"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H 'Content-Type: application/json' "$PACT_BROKER_URL/pacticipants/marketplace-api/versions/$VERSION/tags/prod"
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-web&version=$VERSION&to=prod"
```

Вивід із прогону на чистому брокері (`VERSION=ad8813b`): публікація — `201`, `verify:provider` — exit 0 і
`Results published to Pact Broker`, тег — `201`. `can-i-deploy` **до** тега `prod` (початок відповіді):

```json
{"summary":{"deployable":null,"reason":"There is no verified pact between version ad8813b of marketplace-web and the latest version of marketplace-api with tag prod (no such version exists)","success":0,"failed":0,"unknown":1}}
```

Той самий запит **після** тега:

```json
{"summary":{"deployable":true,"reason":"All required verification results are published and successful","success":1,"failed":0,"unknown":0}}
```

Тег `prod` ставиться на версію **провайдера** — ту саму, яку `verify:provider` передав як
`providerVersion`; у цій послідовності крок із тегом імітує деплой провайдера (у CI це окремий крок
`record-deployment`, який виконується лише після гейта). Повторна публікація того самого контракту дає `200`, а не `201`; щоб повторити
послідовність із чистого стану, перестворіть брокер: `docker compose up -d --force-recreate --wait pact-broker`.

### CI

`.github/workflows/ci.yml`: job `db` — compose-стенд (Postgres, PgBouncer, RabbitMQ, два Redis, MinIO), одноразова
ES256-пара для прогону (`scripts/jwt-keys.mjs` → `$GITHUB_ENV`; справжній ключ — у сховищі), міграції, демо
ДЗ #14, #19, #22, #23 і #24, бекап і drill; job `tests` — `test:integration` і `test:e2e`; job `contract` — pipeline контракту,
де кожен тег ставить крок деплою, а не крок перевірки:

1. `test:contract` → публікація контракту (`scripts/pact-broker.sh publish`);
2. `verify:provider` з публікацією результату;
3. **гейт провайдера** — `can-i-deploy marketplace-api … to=prod`: чи сумісна ця версія провайдера з
   консюмерами, що зараз у prod; job падає, якщо `deployable` не `true`;
4. тільки на `push` у `master`: **деплой провайдера** (імітований) і `record-deployment marketplace-api` —
   саме цей крок ставить тег `prod`;
5. тільки на `master`: **гейт консюмера** — `can-i-deploy marketplace-web … to=prod` проти провайдера, що
   тепер у prod; далі деплой консюмера і його `record-deployment`.

`PACT_BROKER_URL` і `PACT_BROKER_TOKEN` приходять із secrets GitHub; без них job піднімає compose-брокер і
працює з ним. На порожньому брокері гейт провайдера проходить з причиною «немає залежностей» — це штатний
bootstrap, провайдер деплоїться першим; змістовним гейт стає з постійним брокером, де теги `prod` лишаються
між прогонами: тоді гейт консюмера на `master` порівнює контракт із тим провайдером, який справді у prod, а
гейт провайдера на кожному PR — з консюмерами у prod. Перевірено локально на тій самій послідовності:
гейт консюмера до деплою провайдера — `unknown`, після — `true`; контракт, який провайдер порушує, валить
`verify:provider`, а його гейт лишається `null`. Паролі дев-бази і брокера в job `db` теж беруться зі secrets
(`DB_PASSWORD`, `BROKER_PASSWORD`, `REFRESH_TOKEN_PEPPER`; за замовчуванням — дев-значення стенда). Workflow локально не запускався.

## Realtime: статус замовлення без перезавантаження

Життєвий цикл замовлення: `pending → paid → processing → shipped → out_for_delivery → delivered`,
`cancelled` дозволений з `pending`, `paid` і `processing`; `delivered` і `cancelled` — кінцеві. Checkout
створює замовлення одразу `paid`, далі статус змінює `PATCH /orders/{id}/status` з тілом `{ "status": … }`:
один крок циклу в транзакції (рядок замовлення під `FOR UPDATE`), недозволений перехід — `409` problem+json.

Подія «статус змінився» народжується в бізнес-логіці (`OrdersService.changeStatus`), а не в контролері, і
йде в одну шину — `OrderEventsService` (`src/orders/order-events.service.ts`). Подія спершу записується в
таблицю `order_events` (міграція `OrderEvents`) **у тій самій транзакції**, що й зміна статусу: номер
`seq` на замовлення обчислюється під локом рядка замовлення і зростає на одиницю, тож він монотонний і
переживає рестарт процесу, а подія без зміни статусу (чи навпаки) неможлива. Після коміту подія йде в RxJS
`Subject`, і з нього її забирають два транспорти:

- **WebSocket** (`src/orders/orders.gateway.ts`, socket.io на тому самому порту): клієнт підключається з
  `auth: { token }` (access-токен ДЗ #24) і шле `join` з `{ orderId }`. Сервер кладе сокет у кімнату `orders:<id>` і відповідає
  ack `{ ok: true, room }` лише якщо замовлення належить цьому користувачу; анонімному або чужому guard
  відмовляє — клієнт отримує подію `exception` з `{ ok: false, error: 'unauthenticated' | 'forbidden' }`
  (так Nest доставляє відмову guard-а в socket.io), ack не приходить. Подія `order.status` емітиться через
  `server.to('orders:<id>')`, тобто тільки в кімнату цього замовлення.
- **SSE** — `GET /orders/{id}/events` із bearer-токеном власника, `content-type:
  text/event-stream`. Потік починається з `retry: 1000`, кожна подія — блок `event: order.status`,
  `id: <seq>`, `data: <OrderStatusEvent JSON>`; раз на 15 секунд іде коментар `: ping`. Нове підключення
  без `Last-Event-ID` отримує всі збережені події замовлення, реконект із `Last-Event-ID: N` — лише події
  з `seq > N`, далі живі; номери ті самі й після рестарту застосунку. Підписка на живі події відкривається
  **до** читання історії з бази, тож подія, що сталася між читанням і підпискою, не губиться, а дублікати
  відсікаються за номером.

Перевірка власника для обох транспортів — один `OrderOwnerGuard` (`src/orders/order-owner.guard.ts`,
`@UseGuards` і на `join`, і на SSE-маршруті): identity він бере з access-токена ДЗ #24 — для WS з
`handshake.auth.token`, для SSE з `Authorization: Bearer` (його вже перевірив глобальний `AuthGuard`), id
замовлення — з тіла `join` або з шляху, і порівнює з `orders.user_id` (адмін проходить). Без токена —
`401` (WS: `exception` з `unauthenticated`), чужому — `403`, невідоме замовлення — `404`, усе до відкриття
потоку. До ДЗ #24 тут був заголовок `X-User-Id`, яким користувач називав себе сам; тепер і SSE, і REST-читання
замовлень доступні лише власнику або адміну.

Запуск і перевірка (застосунок на `http://localhost:3000`; перші два рядки — локальне сховище з ДЗ #11,
пропустіть їх, якщо `.env` і `secrets/db_password` уже є):

```bash
cp .env.example .env
cp secrets/db_password.example secrets/db_password
npm ci && npm run db:up && npm run build && npm run migrate && npm run events:topology && npm run seed && npm start
```

У другому терміналі залогіньтесь seed-користувачем 1 (він `admin`, тож може і замовляти, і міняти статус;
пароль seed-користувачів — `password`), створіть замовлення й змінюйте статус:

```bash
export TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"seed.user1@example.com","password":"password"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).access_token))')
```

```bash
curl -s -X POST localhost:3000/orders -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: order-$(date +%s)" -d '{"user_id":1,"items":[{"product_id":2,"quantity":1}]}'
```

```bash
for s in processing shipped out_for_delivery delivered; do curl -s -X PATCH localhost:3000/orders/<id>/status -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"status\":\"$s\"}"; echo; done
```

SSE-заголовок, формат подій і відновлення після `Last-Event-ID: 3` (чотири зміни вище дають події 1..4,
тож перший `id:` у відповіді — `4`). Токен — власника замовлення, створеного командою вище; без токена
відповідь — `401` problem+json, із чужим — `403`:

```bash
curl -sN --max-time 2 -H "Authorization: Bearer $TOKEN" -D - -o /dev/null localhost:3000/orders/<id>/events | grep -i '^content-type'
```

```bash
curl -sN --max-time 5 -H "Authorization: Bearer $TOKEN" localhost:3000/orders/<id>/events
```

```bash
curl -sN --max-time 2 -H "Authorization: Bearer $TOKEN" -H 'Last-Event-ID: 3' localhost:3000/orders/<id>/events | grep '^id:' | head -1
```

Headless-демо ізоляції кімнат — `scripts/realtime-demo.mjs` (`socket.io-client`). Скрипт сам створює два
замовлення (покупці 1 і 2, перший товар зі stock > 0), підключає двох клієнтів, чекає ack на `join`,
змінює статус замовлення A через `PATCH` і друкує `A_RECEIVED` / `B_RECEIVED`. Основний прогін — клієнти в
різних кімнатах, контрольний `--same-room` — обидва в кімнаті замовлення A (другий клієнт тоді заходить як
власник A); код виходу 0 лише якщо результат збігся з очікуванням режиму. Той самий код, різниця лише в
прапорці. Адреса застосунку — `API_URL` (за замовчуванням `http://localhost:3000`).

```bash
node scripts/realtime-demo.mjs; echo "exit=$?"
```

```bash
node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
```

Вивід із прогону:

```
FOREIGN_JOIN=refused
ANONYMOUS_JOIN=refused
MODE=separate-rooms ORDER_A=64 ROOM_B=orders:65
A_RECEIVED=1
B_RECEIVED=0
ROOM_ISOLATION=ok
exit=0
```

```
ANONYMOUS_JOIN=refused
MODE=same-room ORDER_A=66 ROOM_B=orders:66
A_RECEIVED=1
B_RECEIVED=1
ROOM_ISOLATION=ok
exit=0
```

Те саме покриває `test/e2e/realtime.e2e-spec.ts`: переходи й `409`, SSE з `Last-Event-ID`, `400`/`403`/`404`
для не-власника, збереження нумерації після рестарту застосунку (другий екземпляр продовжує `3, 4`), кімнати
з перевіркою власника.

**Два інстанси.** Історія подій уже спільна (таблиця `order_events`), тому SSE-реконект на будь-який
інстанс дограє пропущене правильно; але живий `Subject` і кімнати socket.io живуть у памʼяті одного процесу:
за двома інстансами за балансувальником клієнт, підключений до інстанса 1, не почує подію, яку опублікував
інстанс 2 (ані по WS, ані по відкритому SSE-потоку). Лікується Redis-адаптером socket.io
(`@socket.io/redis-adapter`: кімнати стають спільними через pub/sub) і тим самим pub/sub для SSE-підписок
(Лекція 23).

## Trade-offs: WebSocket vs SSE

| Критерій | WebSocket (socket.io) | SSE |
| --- | --- | --- |
| Напрям каналу | двонаправлений: клієнт шле `join`, сервер — події | лише сервер → клієнт; команди йдуть окремими HTTP-запитами |
| Реконект і відновлення | реконект робить socket.io-client, але пропущені події не відновлюються самі — потрібен власний протокол (повторний `join`, свій курсор) | вбудовано в протокол: браузер сам перепідключається (`retry:`) і шле `Last-Event-ID`, сервер дограє пропущене з буфера |
| Вимоги до інфраструктури | upgrade до WS на проксі/балансувальнику, sticky sessions або Redis-адаптер для кількох інстансів | звичайний HTTP/1.1 keep-alive, проходить крізь будь-який проксі; треба лише вимкнути буферизацію відповіді |
| Ціна на подію | мінімальна: фрейм без HTTP-заголовків, одне зʼєднання на багато кімнат | текстовий блок на зʼєднання; одне зʼєднання на один ресурс, у браузері ліміт зʼєднань на HTTP/1.1 |
| Формат | будь-який (бінарний теж), довільні імена подій | тільки текст у UTF-8 |
| Авторизація підписки | `join` з перевіркою власника (guard на повідомленні, відмова — подія `exception`) | лише заголовки першого запиту: той самий guard на маршруті, але браузерний `EventSource` не вміє слати заголовки — із справжньою auth це буде cookie або токен у query |

Для нотифікацій «статус замовлення змінився» у проді я лишив би **SSE**: потік тут строго односпрямований,
відновлення після обриву потрібне (покупець не має пропустити «доставлено»), і протокол дає його безкоштовно
разом із `Last-Event-ID`, а інфраструктурно це звичайний HTTP без sticky sessions і Redis-адаптера. WebSocket
виправданий там, де клієнт теж шле потік повідомлень — чат із продавцем або живий кошик, — і тоді один
socket.io-канал закриє обидва напрямки.

## Async-події через RabbitMQ

Realtime з ДЗ #18 доставляє лише тому, хто підключений зараз. Для всього, що має дожити до появи одержувача,
між API і його читачами стоїть брокер — RabbitMQ 4.2 (LTS-серія з підтримкою до 2030; сервіс `rabbitmq` у
`docker-compose.yml`, образ із суфіксом `-management`: AMQP на `5672`, вебморда на `15672`). Він не має нічого
спільного з Pact Broker із розділу «Тестування»: той зберігає контракти, цей — повідомлення.

### Топологія

Оголошує її споживач при старті (`startConsumer` → `declareTopology` у `src/events/topology.ts`) або бутстрап-крок
`npm run events:topology`; продюсер лише перевіряє, що exchange існує (`checkExchange`), і не знає, хто його
слухає.

| Обʼєкт | Імʼя | Навіщо |
| --- | --- | --- |
| topic-exchange | `shop.events` | усі події домену; routing key = тип події |
| quorum-черга | `fulfillment.order-placed` | binding `order.placed`; `x-dead-letter-exchange: shop.events.dlx`, `x-delivery-limit: 3` |
| classic-черга | `fulfillment.order-placed.retry` | retry-черга: `x-message-ttl: 2000`; після TTL брокер сам повертає повідомлення в робочу чергу (`x-dead-letter-exchange: ''` + `x-dead-letter-routing-key`) |
| fanout-exchange + черга | `shop.events.dlx` → `shop.events.dlq` | окремий контур DLQ; причина смерті — у заголовках `x-death` |
| fanout-exchange + черга | `shop.events.unrouted` | alternate exchange для `shop.events`: подія з routing key без binding не зникає мовчки (confirm при цьому позитивний), а лягає сюди |

DLQ і unrouted — classic durable: обсяг малий, а delivery-limit (у 4.x quorum-черги мають його за
замовчуванням — 20) там шкодив би: повідомлення, яке оператор перечитує, не має зникнути. Аргументи черги
незмінні — якщо змінити `x-delivery-limit` у коді, `assertQueue` впаде з `406 PRECONDITION_FAILED`; чергу треба
видалити (`rabbitmqctl delete_queue fulfillment.order-placed`) або переносити налаштування в політику.

### Подія і публікація

Контракт `order.placed` (`src/events/order-placed.ts`) — спроектований конверт, а не сутність через spread:
`eventId`, `type`, `occurredAt`, `payload: { orderId, userId, totalCents, items[{ productId, quantity }] }`;
споживач валідує його zod-схемою. `eventId` стабільний — це UUID (версія 5-подібна, SHA-1) від
`order.placed:<orderId>`, тож повторна публікація тієї ж події (ретрай продюсера після втраченого confirm) має
той самий id; за ним і за `orderId` споживач упізнає дубль.

Подія виходить із бізнес-операції: `checkout` пише її в таблицю `outbox` тією самою транзакцією, що й
замовлення, а в брокер її виносить relay (розділ «Outbox та ідемпотентність») через `EventPublisher`
(`src/events/publisher.ts`) — confirm-канал (`createConfirmChannel`), `persistent: true`, `messageId =
eventId`, `waitForConfirms()` до позначки `published_at`. Ідемпотентний повтор `POST /orders` з тим самим
`Idempotency-Key` не створює другого рядка outbox, тож і не публікує вдруге (E2E-тест). Якщо exchange не
оголошено, API не стартує (помилка з підказкою `npm run events:topology`), а не губить події в нікуди. Після
обриву зʼєднання з брокером наступна публікація перепідключається сама; `/health` стан брокера не перевіряє —
недоступний брокер видно по рядках outbox із `published_at IS NULL` і зростанням `attempts`, клієнт API цього
не помічає.

### Споживач

`npm run consume` → `src/consumer.ts` (у контейнері — той самий образ із командою `node dist/consumer.js`);
бібліотечна частина — `src/events/consumer.ts`:

- `noAck: false`, `channel.ack` — **після** ефекту. `prefetch=20` (константа `PREFETCH`): ефект — один `INSERT`
  на 2–5 мс, 20 × 5 мс = 0,1 с ≪ `consumer_timeout` 30 хв; `prefetch=1` для 2-мілісекундної роботи — зайвий
  round-trip на кожне повідомлення, а дефолтний 0 — перший споживач забирає всю чергу, другий простоює.
- Після ефекту споживач ставить у чергу BullMQ задачу `order.confirmation` з `jobId = eventId` (ДЗ #23):
  повторна доставка (у тому числі після невдалого `add`) дає ту саму задачу, а ефект, що остаточно впав, листа
  не породжує.
- Ефект — створити відправлення: `INSERT INTO shipments (order_id, event_id) … ON CONFLICT (order_id) DO NOTHING
  RETURNING order_id` (міграція `Shipments`): природний ключ бізнес-операції, порожній `RETURNING` → дубль, ефект
  пропущено. Сховище — та сама Postgres, разом із позначкою в `processed_messages` (ДЗ #22), тому дедуп переживає
  рестарт і працює між інстансами; `Set` у памʼяті тут не рахувався б.
- Ефект не вдався (у демо — FK: замовлення не існує; у житті — моргання бази) → не `reject(requeue=true)`, бо
  миттєвий повтор пропалив би всі спроби за мілісекунди і відправив живу подію в DLQ, а **retry-черга з
  TTL**: споживач перекладає повідомлення в `fulfillment.order-placed.retry` з лічильником `x-retry`
  (confirm-канал, `ack` оригіналу лише після підтвердження), через `RETRY_DELAY_MS` = 2 с брокер сам повертає
  його в робочу чергу, і так до `MAX_RETRIES` = 3; четверта невдача — `reject(requeue=false)`, DLQ з причиною
  `rejected`. Збій бази коротший за 6 с подія переживає. `x-delivery-limit=3` на робочій черзі лишається
  запобіжником від crash-loop: якщо процес падає до `ack` раз за разом, брокер сам переносить повідомлення
  в DLQ з причиною `delivery_limit` (інтеграційний тест).
- Повідомлення, що порушує контракт (не JSON, не та схема), валідним не стане ніколи → `reject(requeue=false)`
  одразу, причина `rejected` (інтеграційний тест).
- `basic.cancel` від брокера (`msg === null`) — не «нічого не прийшло», а сигнал: процес завершується з кодом 1,
  щоб його перезапустив супервізор; `SIGTERM`/`SIGINT` — коректне завершення (`cancel`, дочекатись in-flight,
  закрити канал).

Позначка про обробку (`processed_messages`) і ефект (`shipments`) комітяться однією транзакцією (ДЗ #22), тож
щілини між «позначив» і «застосував» немає; а от між ефектом і `ack` вона є, саме її показує `demo:duplicate`,
і закриває її не менша щілина, а дедуп за `eventId` на наступній доставці.

### Чому at-least-once, а не exactly-once

`ack` — це не «дійшло», це «я більше не вимагаю повтору». Підтвердив до ефекту — падіння між ack і ефектом
втрачає роботу (at-most-once). Підтвердив після — падіння між ефектом і ack повертає повідомлення в чергу, і
ефект виконується вдруге (at-least-once). Третього варіанта у доставки немає: exactly-once на рівні брокера не
існує ні в RabbitMQ, ні деінде. Тут обрано at-least-once (ручний `ack` після ефекту), а щоб результат був один,
ефект зроблено ідемпотентним: він виражений через природний ключ `order_id`, і повторна доставка впирається в
`ON CONFLICT DO NOTHING`. At-least-once доставка + ідемпотентний ефект = exactly-once **результат**. Операція
на кшталт `UPDATE products SET stock = stock - 1` такою не була б — її довелося б захищати ключем ідемпотентності
(`eventId` у таблиці оброблених), а не природним ключем.

### Демо

Три скрипти (`src/demo-publish.ts`, `src/demo-dlq.ts`, `src/demo-duplicate.ts`, спільний харнес
`src/events/demo-harness.ts`) ходять у брокер і базу через `scripts/with-secrets.sh dev` — як `migrate`/`seed`.
Кожен спершу приводить стан до чистого (оголошує топологію, `purgeQueue` робочої і retry-черги; DLQ і unrouted
не чистяться — там лежать справжні отруєні повідомлення попередніх прогонів, тому `dlq` у підсумку — приріст
DLQ за цей прогін, а `dlq-depth` — її повна глибина; якщо до черги вже підключений сторонній споживач — наприклад, `npm run consume` в іншому терміналі, — демо
відмовляється стартувати, бо його числа були б хибними), запускає споживача **окремим процесом**
(`fork(dist/consumer.js)`; той звітує стадії через IPC і сам завершується, якщо батьківський процес зник), друкує підсумок
рядками `ключ=значення` і завершується з кодом ≠ 0, якщо інваріант порушено. Інваріанти — рівно умови
контракту грейдера (скажімо, `dlq-reason` — будь-яка з чотирьох причин: під політикою `message-ttl` вона
буде `expired`, і це теж легальний DLQ), решта чисел довідкові. Дані створюються на місці (продавець,
покупець, товар → `checkout`), `seed` не потрібен; потрібні лише міграції.

`npm run demo:publish` — пʼять checkout → пʼять рядків outbox → один прохід relay у процесі демо (`relayed=5`)
→ пʼять `order.placed` у черзі **до** старту споживача (`queued=5`: брокер зберігає до появи одержувача), далі
споживач забирає все:

```
published=5
relayed=5
queued=5
delivered=5
effect=5
acked=5
work=0
dlq=0
dlq-depth=0
prefetch=20
```

`npm run demo:dlq` — отруєне повідомлення: валідна подія про замовлення, якого в базі немає. Чотири спроби з
паузою 2 с між ними (три проходи через retry-чергу), потім `reject(requeue=false)` і DLQ. Демо знаходить
своє повідомлення в DLQ за `messageId` (читає чергу без `ack` і повертає все назад `nackAll(requeue)`) і бере
причину із запису `x-death` робочої черги: перші «смерті» цього повідомлення — `expired` у retry-черзі, тобто
механізм повтору, а не причина поховання, тому `x-first-death-reason` тут не годиться:

```
published=1
deliveries=4
retries=3
retry-delay-ms=2000
rejected=1
work=0
retry=0
dlq=1
dlq-depth=1
dlq-reason=rejected
effect=0
```

`npm run demo:duplicate` — обрана форма дубля: **kill -9 дочірнього процесу-споживача**. Перший споживач
запускається з `CONSUMER_CRASH_AFTER_EFFECT=1`: після `INSERT` (ефект є), але до `ack`, він убиває власний
процес `SIGKILL` — для брокера це те саме, що `kill -9` ззовні чи падіння пода: сокет закриває ОС, брокер бачить
обрив і повертає непідтверджене повідомлення в чергу з `redelivered=true`. Другий споживач отримує його, `INSERT`
упирається в `ON CONFLICT`, ефект пропущено, `ack`:

```
published=1
deliveries=2
redelivered=1
applied=1
skipped=1
acked=1
effect=1
work=0
dlq=0
dlq-depth=1
```

`deliveries=1` тут означало б, що дубля не було і демо нічого не довело (типова причина — `noAck: true`), тому
інваріант вимагає `deliveries ≥ 2` **і** `effect=1`.

### Що лишилось за межами

- Пауза між спробами фіксована: одна retry-черга з TTL на рівні черги. Експоненційний backoff потребує або
  per-message `expiration` — а в нього head-of-line проблема: довге повідомлення на голові черги тримає
  короткі за ним, — або окремої retry-черги на кожен рівень затримки. Повернення повідомлень із DLQ у роботу
  (shovel або ручний replay) теж поза ДЗ.
- `dead-letter-strategy` — дефолтний `at-most-once`: перенесення в DLX не підтверджується. `at-least-once`
  вимагає `overflow: reject-publish` і без нього не вмикається мовчки — брокер відкочується на `at-most-once` і
  пише про це лише в лог.
- Transactional outbox і `processed_messages` в одній транзакції з ефектом додано в ДЗ #22 (наступний розділ);
  Redis і BullMQ поверх тієї ж події — ДЗ #23.


## Outbox та ідемпотентність

У ДЗ #19 `OrdersService.create` публікувала `order.placed` одразу після COMMIT checkout — і між цими двома
записами був проміжок, у який вміщається падіння процесу: замовлення є, події немає, і жоден ретрай цього не
полагодить, бо спільного COMMIT у Postgres і RabbitMQ не існує. Тепер подія народжується в тій самій
транзакції, що й замовлення, а назовні її виносить окремий relay. Рахунок за це — at-least-once доставка —
оплачується ідемпотентністю на трьох рівнях.

### Таблиця outbox

Міграція `Outbox` (`src/migrations/*-Outbox.ts`, не `synchronize`) створює три таблиці, `OutboxRetry` додає до
`outbox` поля backoff (`next_attempt_at`, `failed_at`, `last_error`):

| Таблиця | Поля | Навіщо |
| --- | --- | --- |
| `outbox` | `id`, `aggregate_type`, `aggregate_id`, `type`, `payload jsonb`, `created_at`, `published_at` (NULL = ще не винесено), `attempts`, `next_attempt_at`, `failed_at`, `last_error`; частковий індекс `idx_outbox_unpublished (created_at, id) WHERE published_at IS NULL` | ролі полів — ті самі, що читає Debezium Outbox Event Router; імена колонок snake_case, тож при переході на CDC їх треба буде або перейменувати на `aggregatetype`/`aggregateid`, або задати `route.by.field=aggregate_type` і `table.field.event.key=aggregate_id` |
| `processed_messages` | `message_id uuid`, `consumer text`, `processed_at`; PK `(message_id, consumer)` | inbox споживача: позначка «цей `eventId` цей консюмер уже обробив» |
| `idempotency_keys` | `key text` PK, `fingerprint`, `result jsonb`, `created_at` | ключі ідемпотентності API-краю, переживають рестарт і спільні для всіх інстансів |

Чистка — `npm run prune` (`src/prune.ts`, через `with-secrets.sh`; у `backup.cron` це другий рядок, щоночі о
03:30, лог у `backups/prune.log`). Він друкує `таблиця=видалено` і прибирає: з `outbox` — опубліковані рядки
старші за 7 днів (до CDC вони нікому не потрібні) і поховані (`failed_at`) старші за 30; з `idempotency_keys`
— ключі старші за 24 години: це вікно повтору клієнта, після нього той самий ключ створить нове замовлення,
і ця межа гарантії названа тут свідомо; з `processed_messages` — позначки старші за 30 днів, тобто довше за
будь-який повтор доставки (retry-черга, DLQ-реплей). Частковий індекс relay росту таблиць не помічає — у
ньому лише `published_at IS NULL`.

### Бізнес-запис і outbox одним COMMIT

`checkout()` (`src/checkout/checkout.ts`) тепер приймає `DataSource` **або** `EntityManager` і в тій самій
транзакції, що списує залишок, знімає гроші й створює замовлення, вставляє рядок `outbox` з `payload =
orderPlaced(toOrderDto(order))` — явною функцією контракту, а не сутністю через spread. Жодного `publish`
усередині транзакції: брокер не вміє відкочуватись, а Postgres — вміє, тож усе, що має зникнути разом із
замовленням, живе в базі. Це і показує `demo:crash-write`.

### Relay на polling

`OutboxRelay` (`src/events/relay.ts`) раз на `RELAY_INTERVAL_MS` = 1 с робить одну транзакцію:
`SELECT … FROM outbox WHERE published_at IS NULL ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100` →
для кожного рядка `publish` (confirm-канал, `messageId = eventId`) → `UPDATE outbox SET published_at = now(),
attempts = attempts + 1` → COMMIT. `SKIP LOCKED`, а не голий `FOR UPDATE`: кілька relay (два інстанси API)
беруть різні рядки замість того, щоб вишикуватись за одним локом. Relay живе всередині API (`EventsModule`
стартує його в `onModuleInit`), тому `npm start` виносить події сам; `npm run relay` — той самий код окремим
процесом, його використовують демо.

Порядок publish → UPDATE міняти не можна. Якщо спершу позначити `published_at`, а потім публікувати, відмова
publish (або падіння між ними) дасть рядок «винесено», якого брокер не бачив — це втрата, і її не лікує ніщо.
У поточному порядку падіння між publish і UPDATE відкочує транзакцію, `published_at` лишається NULL, і
наступний прохід публікує подію **вдруге** — це дубль, і його лікує дедуплікація на споживачі. Вибір тут не між
«добре» і «погано», а між дублем і втратою; дубль дешевший. Те саме стосується помилки publish: відповідь
брокера могла загубитись, подія вже може бути в черзі, тому relay не відкочує рядок як «не відправлений», а
пробує знову, і дедуп на споживачі обовʼязковий незалежно від акуратності relay.

Повтор не крутиться щосекунди: невдалий publish записує `attempts + 1`, `last_error` і `next_attempt_at =
now() + min(2^attempts, 300) с`, а вибірка relay бере лише рядки з `next_attempt_at <= now()` — експоненційний
backoff від 2 с до 5 хв. Після `OUTBOX_MAX_ATTEMPTS` = 5 relay сам публікує подію в DLX `shop.events.dlx` із
заголовком `x-relay-failure` і ставить `failed_at`: рядок виходить із вибірки, а повідомлення чекає оператора в
`shop.events.dlq` поруч з іншими отруєними. Якщо недоступний і DLX (лежить сам брокер), рядок лишається у
вибірці з максимальною паузою — брокер повернеться, relay дожене. Інтеграційний тест ганяє цей цикл з
паблішером, який падає завжди.

Порядок доставки `ORDER BY created_at, id` задає лише порядок вибірки: `SKIP LOCKED` розкидає рядки між
воркерами, а `bigserial` видає номер на `nextval`, видимим же рядок стає на COMMIT, — тому в relay стоїть
`published_at IS NULL`, а не курсор «усе більше за останній id». Гарантованого порядку між подіями тут немає і
він не потрібен: `order.placed` для одного замовлення рівно одна.

### Ідемпотентність на трьох рівнях

1. **Природний ключ ефекту.** Відправлення створюється `INSERT INTO shipments (order_id, …) ON CONFLICT
   (order_id) DO NOTHING` (`src/events/consumer.ts`): повтор нічого не змінює, бо ключ — це сама
   бізнес-операція. `UPDATE stock = stock - 1` тут не пройшов би — друга доставка зняла б удвічі.
2. **Inbox.** Той самий споживач у тій самій транзакції спершу робить `INSERT INTO processed_messages
   (message_id, consumer) ON CONFLICT DO NOTHING RETURNING`; порожній `RETURNING` — дубль, ефект пропущено;
   інакше ефект і позначка комітяться разом. Позначити в Redis, а ефект записати в Postgres було б тим самим
   dual write, тільки на споживачі.
3. **Ключ ідемпотентності на API-краю.** `IdempotencyStore` (`src/common/idempotency.ts`) більше не в памʼяті
   процесу: `INSERT INTO idempotency_keys (key, fingerprint) ON CONFLICT (key) DO NOTHING RETURNING` відкриває
   ту саму транзакцію, в якій далі йде checkout, і `result` записується туди ж перед COMMIT. Повторний запит із
   тим самим ключем бачить рядок і повертає збережену відповідь з `Idempotency-Replay: true`; одночасні запити
   з одним ключем вишиковуються на цьому INSERT (другий чекає COMMIT першого) — інтеграційний тест ганяє
   пʼять паралельних; той самий ключ з іншим тілом — `422`; запит, що впав, рядка не лишає, і ключ можна
   повторити. Ключ ідентифікує намір, а не тіло: два однакові замовлення з різними ключами — два замовлення,
   хеш тіла схлопнув би їх в одне. `fingerprint` потрібен лише щоб відрізнити помилку клієнта.

### Демо

Три скрипти (`src/demo-outbox.ts`, `src/demo-crash-write.ts`, `src/demo-crash-relay.ts`) на тому самому
харнесі, що й ДЗ #19: через `scripts/with-secrets.sh dev`, самоочисні (топологія, `purgeQueue` робочої і
retry-черги), споживач і relay — дочірні процеси (`fork(dist/consumer.js)` / `fork(dist/relay.js)`, звітують
стадії через IPC), підсумок `ключ=число`, exit ≠ 0 при порушеному інваріанті. Дані створюються на місці,
`seed` не потрібен, лише міграції.

`npm run demo:outbox` — два `placeOrder` з одним `Idempotency-Key`, далі relay і споживач:

```
requests=2
replayed=1
same-order=1
orders=1
outbox=1
published=1
deliveries=1
effect=1
processed=1
work=0
dlq=0
```

`npm run demo:crash-write` — транзакція з `checkout` падає **після** вставки рядка в outbox (усередині
транзакції рядок видно: `outbox-in-transaction=1`), далі relay робить два проходи, споживач чекає 1,5 с:

```
write-failed=1
outbox-in-transaction=1
orders=0
outbox=0
published=0
deliveries=0
effect=0
work=0
```

`npm run demo:crash-relay` — обрана форма: **справжній kill -9 дочірнього relay**. Перший relay запускається з
`RELAY_CRASH_AFTER_PUBLISH=1` і після підтвердженого `publish`, до `UPDATE published_at`, убиває власний процес
`SIGKILL`; транзакція відкочується, рядок лишається з `published_at IS NULL` (`published-after-crash=0`).
Другий relay публікує подію вдруге; споживач отримує дві доставки, перша створює відправлення, друга впирається
в `processed_messages`:

```
outbox=1
published-after-crash=0
published=1
relay-runs=2
deliveries=2
applied=1
skipped=1
effect=1
processed=1
work=0
dlq=0
```

Той самий сценарій живе й інтеграційним тестом на testcontainers (`test/integration/outbox.int-spec.ts`): там
«падіння» — виняток рівно в тій самій точці (`afterPublish` кидає), як крок 8 у коді лекції.

Exactly-once доставки не існує — це задача двох генералів. Є at-least-once доставка (outbox + relay, який
краще повторить, ніж загубить) плюс ідемпотентний ефект (природний ключ + inbox в одній транзакції), і разом
вони дають exactly-once **результат**.


## Redis: кеш, сесії, ліміти, черга

Поверх події з ДЗ #22 у стенді зʼявляється Redis — і одразу **два** інстанси (`docker-compose.yml`):

| Сервіс | Порт хоста | Конфіг | Що там живе |
| --- | --- | --- | --- |
| `redis-cache` | `6379` | `--maxmemory 64mb --maxmemory-policy allkeys-lru`, без persistence | картки товарів (`product:<id>`) і single-flight локи — усе, що можна втратити |
| `redis-queue` | `6382` | `--maxmemory-policy noeviction --appendonly yes --appendfsync everysec`, том `redisqueue` | черга BullMQ, сесії, лічильники rate-limit — усе, що втрачати не можна |

Чому два: кеш потребує `maxmemory` + `allkeys-lru`, а документація BullMQ вимагає протилежного —
`noeviction`, бо черга «cannot work properly if Redis evicts keys arbitrarily». `maxmemory-policy` одна на
весь процес, `SELECT 1` її не розводить, тому це два контейнери. Сесії й лічильники ліміту теж у
`redis-queue`: сесія в `allkeys-lru` колись вилетить і дасть розлогінення, яке ніхто не відтворить, а
вилетілий лічильник обнулив би ліміт під навантаженням — рівно тоді, коли він потрібен. Третій інстанс під
«стан» був би чистішим, але для курсового два контейнери достатньо; у `README` це розмежування і є відповідь
«що обрав і чому». Адреси — `REDIS_URL` і `REDIS_QUEUE_URL` у тому самому сховищі, що й база (ДЗ #11).

### Cache-aside на картці товару

«Важке» читання — `GET /products/{id}`: картка з `sold` (сума `order_items.quantity` по нескасованих
замовленнях, `JOIN` + `GROUP BY`, `src/products/product-card.ts`). `CacheAside` (`src/redis/cache-aside.ts`):
промах → база → `SET key value EX ttl`, влучання → тільки Redis. TTL завжди з джитером: `300 + random(0..60)` с,
інакше ключі, прогріті одним проходом, протухнуть в одну секунду і дадуть stampede на порожньому місці.
Явна інвалідація — додатково: `OrdersService.create` після успішного checkout видаляє картки куплених товарів,
тож залишок після покупки читається свіжим (E2E-тест); планувальник черги раз на хвилину перегріває 20
найновіших карток.

Промах у базі теж кешується — негативний кеш: `null` лягає в Redis на короткі `30 + random(0..30)` с
(`negativeTtlSec`), інакше лавина на неіснуючий id (`GET /products/424242` × 25) дає 25 походів у базу: лок
відпрацьовує, але переможець нічого не записує, і кожен наступний очікувач іде вантажити сам. Короткий TTL —
щоб товар, що зʼявиться, не чекав 5 хвилин. Кеш не роняє запити: кожна операція з Redis обгорнута, помилка
читання — промах, помилка запису — просто не закешували, недоступний Redis — пішли в базу напряму. На стоковому конфізі (`maxmemory 0`, `noeviction`) Redis
починає кидати `OOM command not allowed` на запис — саме тому в кеш-інстансі стоїть `allkeys-lru`.

### Захист від stampede: single-flight лок

N одночасних промахів на один ключ дають один похід у базу: перший бере `SET lock:<key> <token> NX PX 3000`,
вантажить, пише кеш і знімає лок; решта чекають по 20 мс, перечитують кеш і виходять з нього. Знімається лише
**свій** лок — Lua `if GET == token then DEL` (compare-and-delete працює на будь-якій версії; `DELEX … IFEQ`
з 8.4 робить те саме однією командою). Голий `DEL` зняв би чужий лок: між «мій лок протух» і «я його знімаю»
вміщається чужий `SET NX`. Якщо переможець упав і лок протух — черговий очікувач бере його сам, а якщо Redis
недоступний узагалі — кожен іде в базу напряму.

**Що станеться, якщо цей лок зламається — і чому це прийнятно.** Лок не рятує від паузи, довшої за його
TTL: процес завмер на GC, лок протух, його взяв інший — і двоє одночасно впевнені, що лок у них. Наслідок тут —
два походи в базу замість одного і два однакові `SET` у кеш: кілька центів і ніякого зіпсованого стану. Тому
це *оптимізація*, і fencing token їй не потрібен. Той самий `SET NX PX` у ролі захисту бізнес-інваріанта
(«не продати більше, ніж є») коштував би подвійного списання — і саме тому в checkout (ДЗ #14) стоїть не лок,
а атомарний `UPDATE … WHERE stock >= n`, у споживачі (ДЗ #19/#22) — унікальний ключ і inbox, а не Redis.
Розподілений лок не замінює ідемпотентність: він діє лише у вікні валідності й лише поки процес не зупинявся.

### Сесії з rolling TTL

`SessionStore` (`src/redis/session.store.ts`) на `redis-queue`: `POST /sessions {user_id}` → `SET session:<id>
{...} EX 1800`; `SessionMiddleware` на кожному запиті з `X-Session-Id` читає сесію через `GETEX session:<id>
EX 1800` — одна команда читає і подовжує TTL, тож активного користувача не викине посеред роботи; `GET
/sessions/me` лише віддає те, що middleware поклав у запит. Сховище — Redis, не памʼять процесу: після
рестарту API сесія жива (демо перезапускає застосунок між запитами). Невідомий або протухлий id — `401`
problem+json. Цей же механізм у ДЗ #24 зустрінеться з JWT.

### Rate-limit на спільному сховищі

`RateLimiter` (`src/redis/rate-limiter.ts`) — **ковзне вікно** на sorted set, одним Lua-скриптом
(`ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` → `PEXPIRE`): між `ZCARD` і `ZADD` інакше влазить інший под, і ліміт
протікає саме під навантаженням — тут атомарність є вимогою коректності, а не оптимізацією. Чому ковзне: воно
не дозволяє сплеску на межі вікон (фіксоване пропускає до 2× ліміту за кілька мілісекунд), а token bucket
сплеск дозволяє свідомо — для публічного API замовлень сплеск нам не потрібен. Лічильник живе в
`redis-queue`, тому два поди ділять один ліміт; клієнт — IP (`request.ip`; за reverse-proxy потрібен
`trust proxy`, інакше всі запити зіллються в один ключ). Довільний заголовок на кшталт `X-User-Id` ключем
бути не може — клієнт крутив би його і обходив ліміт; з автентифікацією (ДЗ #24) ключем стане `sub` токена. `RateLimitGuard`
(`src/redis/rate-limit.guard.ts`, глобальний, окрім `/health`) віддає `429` problem+json із `Retry-After` у
секундах до звільнення найстаршого слота і заголовки `RateLimit-Limit`/`RateLimit-Remaining`; ліміт — `RATE_LIMIT`
за `RATE_LIMIT_WINDOW_MS` (дефолт 100 за 10 с). Якщо Redis недоступний, guard пропускає запит і пише в лог:
для ліміту доступність сервісу важливіша за точність.

### Черга BullMQ

Одна черга `marketplace` (`src/queue/queue.ts`) на `redis-queue`, воркер — `npm run worker`
(`src/queue-worker.ts`). Зʼєднання різні для двох ролей: воркер — `maxRetriesPerRequest: null`, щоб при обриві
зʼєднання чекати Redis, а не падати; `Queue` у продюсера (споживач, демо) — `enableOfflineQueue: false`,
`maxRetriesPerRequest: 1`, обмежений backoff перепідключення і таймаут 2 с на `add` (`enqueue()` у
`src/queue/queue.ts`): при впалому Redis постановка задачі падає за секунди, а не висить, доки ioredis перебирає
повтори; споживач тоді йде звичайним шляхом повтору доставки:

- `order.confirmation` — споживач `order.placed` (ДЗ #19) після ефекту ставить задачу з `jobId = eventId`:
  повторна доставка події дає ту саму задачу, два `add` з одним `jobId` — одну задачу в черзі;
- `catalog.refresh` — планувальник `upsertJobScheduler('catalog-refresh', { every: 60000 })`: перегріває
  картки 20 найновіших товарів у кеш. `upsert`, а не `add`: рестарт воркера не плодить планувальників
  (`repeat`/`getRepeatableJobs` у BullMQ 6 немає);
- дефолтні опції задач: `attempts: 3`, `backoff: { type: 'exponential', delay: 500, jitter: 0.25 }`,
  `removeOnComplete: { age: 3600 }` (не `true` — це вимкнуло б дедуп за `jobId`), `removeOnFail: { age: 86400 }`.

### Демо

Чотири скрипти через `scripts/with-secrets.sh dev`, самоочисні, друкують `ключ=число`. `demo:cache` працює з
Redis і базою напряму (брокер йому не потрібен); `demo:session` і `demo:ratelimit` піднімають справжній API в
процесі демо (`src/redis/demo-api.ts`: `DB_URL` і файл-секрет
збираються з `DB_*`, тому грейдеру достатньо `SKIP_VAULT=1`), тож `429`, `Retry-After` і `X-Session-Id` —
справжні HTTP-відповіді.

`npm run demo:cache` — `FLUSHDB` кеш-інстанса, 60 товарів прогріваються картками, один ключ знімається і на
нього йдуть 25 одночасних читань, далі 100 читань теплого кеша, потім 25 одночасних читань неіснуючого id
(негативний кеш); `db-calls` рахує виклики `loadProductCard`, тобто SQL до бази, а не виклики кешованої функції:

```
cache-lru=1
cache-maxmemory=1
warmed=60
ttl-min=300
ttl-max=358
ttl-distinct=41
concurrent=25
db-calls=1
identical-results=1
lock-left=0
warm-reads=100
db-calls-warm=0
concurrent-missing=25
db-calls-missing=1
negative-ttl=47
```

`npm run demo:session` — `POST /sessions`, пауза 2 с, `GET /sessions/me` (TTL до і після читається з Redis
напряму), ще пауза і читання, рестарт API і читання після рестарту:

```
requests=4
sessions=1
in-redis=1
state-noeviction=1
ttl-before=1798
ttl-after=1800
ttl-renewed=1
survives-restart=1
```

`npm run demo:ratelimit` — два екземпляри API з `RATE_LIMIT=5`, вісім запитів по колу з однієї IP-адреси:

```
instances=2
limit=5
window-ms=10000
requests=8
allowed=5
blocked=3
status=429
retry-after=1
retry-after-seconds=10
```

`npm run demo:queue` — `obliterate` черги, два `add` з одним `jobId` (задача падає двічі через лічильник у
`data`), планувальник раз на секунду, воркер у процесі демо, вікно спостереження 3,5 с; відмовляється
стартувати, якщо до черги підключений `npm run worker`:

```
queue-noeviction=1
fail-times=2
attempts=3
completed=1
added=2
queued=1
schedulers=1
observe-ms=3500
scheduled-runs=4
```

### Що лишилось за межами

- Раннього оновлення (probabilistic early expiration) немає — на холодному ключі воно не рятує, демо показує
  саме лок.
- Витіснення конкретного ключа не демонструється: LRU у Redis наближений (`maxmemory-samples 5`), жертва
  обирається з вибірки; `cache-lru`/`cache-maxmemory` читаються з `CONFIG GET` у рантаймі.
- Сесія не замінює токен у guard-і власника (ДЗ #18): з ДЗ #24 там access-токен, а `POST /sessions` сам
  вимагає bearer і створює сесію для його `sub`.


## Auth

`POST /orders` більше не може зробити будь-хто від чийого завгодно імені. Дві різні задачі розведені жорстко:
**автентифікація** («хто це?») — факт, який перевіряється криптографією: підпис ES256 на access-токені;
**авторизація** («чи можна йому це?») — рішення з даних, яких у токені немає: власник замовлення, роль продавця.
Перша дає `401`, друга — `403`, і це не стилістика: клієнтський SDK на `401` іде рефрешити токен, а на `403`
показує помилку.

### Змінні зі сховища

| Змінна | Джерело | Навіщо | Формат |
| --- | --- | --- | --- |
| `JWT_PRIVATE_KEY` | сховище (#11) | підпис access-токенів | base64 від PEM PKCS#8, EC P-256 |
| `JWT_PUBLIC_KEYS` | сховище (#11) | keyring для перевірки підпису | `kid:base64` від PEM SPKI через кому; один запис або два під час ротації |
| `JWT_KID` | сховище (#11) | `kid` у заголовку токена: яким ключем підписано; має бути в keyring | рядок `[A-Za-z0-9_.-]+`, напр. `dev`, `2026-11` |
| `REFRESH_TOKEN_PEPPER` | сховище (#11) | HMAC-«перець» для хешів refresh-токенів | випадковий рядок ≥ 16 байт |

Дефолтів у схемі (`src/config/env.schema.ts`) немає — дефолт тут дорівнював би зашитому в код ключу. Схема
виконується першою дією процесу, до пулу Postgres, тому голий `npm run start` без ключа падає з exit ≠ 0 і
називає змінну, якої бракує; `npm run start:vault` і три демо йдуть через `scripts/with-secrets.sh dev`.
Дев-пару генерує `node scripts/jwt-keys.mjs >> .env` (у git її нема, `.env` ігнорується); ціна витоку
`DB_URL` — доступ до бази з мережі, ціна витоку ключа підпису — токен будь-кого без жодного доступу.

Відбитки публічних ключів (SHA-256 від SPKI DER, перші 16 байт), як доказ, що оточення різні:

| Оточення | `kid` | Відбиток |
| --- | --- | --- |
| dev (локальний `.env`) | `dev` | `8cb7:7580:6988:16c8:eacd:ce00:976b:739b` |
| prod (сховище, env `prod`) | `prod-2026-11` | `4375:aa4d:99bd:6bb2:8ffd:f029:3d1a:93b7` |

Відбиток поточного ключа застосунок пише в лог на старті (`signing key kid=… fingerprint=…`) — це все, що
про ключ взагалі може зʼявитись у логах: токени, їхні хвости й хеші в лог не пишуться, лише `jti`,
`family_id` і відбиток.

### Токени

`POST /auth/login {email, password}` (паролі — scrypt із сіллю, `src/auth/password.ts`) → пара:

- **access** — JWT ES256 на 10 хвилин (`src/auth/jwt.ts`, `jose`): `sub`, `role`, `fid` (сімʼя
  refresh-токенів), `jti`, `iss`/`aud`, заголовок `alg: ES256, kid`. Обрано ES256, а не RS256: OWASP позначає
  RS256 «Not recommended», ES256 дає підпис 64 байти при тій самій стійкості, а ключ P-256 — 32 байти проти
  2048 біт RSA. Верифікація — `jwtVerify(token, key, { algorithms: ['ES256'], issuer, audience })`: явний
  allowlist алгоритмів (RFC 8725 §3.1) — єдиний надійний запобіжник від algorithm confusion; ключ береться з
  keyring за `kid`, невідомий `kid` — `401`.
- **refresh** — 32 випадкових байти, непрозорий (не JWT), 30 днів. У базі лежить не він, а
  `token_hash = HMAC-SHA256(pepper, token)`: дамп таблиці `refresh_tokens` без «перцю» зі сховища — не дамп
  чинних сесій.

Міграція `Auth` (не `synchronize`): `users.role` (`buyer` / `seller` / `admin`, CHECK) і `users.password_hash`;
`refresh_tokens (id, user_id, family_id, token_hash UNIQUE, created_at, expires_at, used_at, revoked_at)` з
індексами по `token_hash` і `family_id`; `access_denylist (jti, expires_at)` з індексом по `expires_at` — ним
`npm run prune` видаляє протухлі `jti` без seq scan (PK по `jti` тут не допомагає).

### Ротація з детекцією повтору

`POST /auth/refresh` в одній транзакції: `SELECT … FOR UPDATE` за хешем → якщо `used_at` уже стоїть, це
повтор: `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = …` на **всю сімʼю** і рядок у лог
`refresh token reuse detected: family=… user=…`; відкликання комітиться, і лише потім клієнт отримує `401`
(відкотити транзакцію разом із `401` — найлегший спосіб втратити саме відкликання, цей дефект спіймало демо).
Інакше — `used_at = now()`, нова пара в тій самій сімʼї, COMMIT. Ротація без сімʼї (RFC 9700 §4.14.2 вимагає
або sender-constrained токен, або ротацію з детекцією) нічого не дає: злодій рефрешиться першим, чесний клієнт
отримує `401` і мовчки перелогінюється, а сесія злодія живе далі. Звʼязок старого й нового токена через
`family_id` існує рівно для того, щоб виявлений повтор було чим відкликати — `demo:reuse` показує, що після
сигналу вилітає і чесний клієнт.

Гонка на клієнті (два паралельні рефреші одним токеном) тут виглядатиме як компрометація. Обрано: вікна
благодаті немає, рефреш серіалізується на клієнті (один проміс на всіх запитах) — так простіше і сервер не
мусить памʼятати «ту саму нову пару» для повторного предʼявлення.

### Чому логаут — це дві дії

Refresh-токен — рядок у базі: `revoked_at` на сімʼю, і він мертвий. Access self-contained: підпис валідний
до `exp`, і без денилиста логаут його не зачепить — тому `POST /auth/logout` у тій самій транзакції кладе
`jti` у `access_denylist` з `expires_at = exp` токена (TTL = залишок життя, не більше: `npm run prune`
прибирає протухлі рядки). Денилист — у Postgres, а не в Redis з ДЗ #23, свідомо: відкликання сімʼї та позначка
`jti` мусять бути одним COMMIT, інакше це той самий dual write, від якого тікали в ДЗ #22; ціна — один
індексний запит на кожен автентифікований виклик (`SELECT … FROM access_denylist WHERE jti = $1 UNION ALL
SELECT … FROM refresh_tokens WHERE family_id = $2 AND revoked_at IS NOT NULL LIMIT 1`), і він же гасить
access-токени сімʼї, вбитої детекцією повтору. Це і є рахунок за «JWT не можна відкликати»: короткий TTL
платить частими рефрешами, денилист — тим, що верифікація перестала бути stateless (RFC 7009 §3).

### 401 ≠ 403 і RBAC на двох рівнях

`AuthGuard` (`src/auth/auth.guard.ts`, глобальний, `@Public()` на `/health`, `GET /products*`, `/auth/login`,
`/auth/refresh`) читає `Authorization: Bearer`, перевіряє підпис, денилист і сімʼю → `401` з причиною
(`missing bearer token`, `invalid token`, `token revoked`), кладе principal у запит; `@Roles(…)` там само дає
`403`, якщо роль не з переліку.

- **Рівень ролі**: `POST /products` — тільки `seller`/`admin` (`403` покупцю); `PATCH /orders/{id}/status` —
  тільки `admin`.
- **Рівень власності** — свідомо не в guard-і: guard стоїть до завантаження ресурсу і не знає `owner_id`, тож
  довелося б ходити в базу двічі. Межа проходить у сервісі: `GET /orders/{id}` — замовлення завантажено, і
  якщо `order.user_id ≠ sub` і роль не `admin` → `403` (`OrdersService.findOne`); `GET /orders` — `WHERE user_id
  = sub` прямо в запиті, адмін бачить усе; `POST /orders` — `user_id` тіла має збігатися з `sub`; `POST /products`
  — `seller_id` тіла має бути своїм. SSE `GET /orders/{id}/events` і WS `join` беруть identity з того ж
  bearer-токена (`handshake.auth.token`) і перевіряють власника в `OrderOwnerGuard` — там ресурс і так треба
  завантажити, щоб відповісти `404`.

Роль у токені — кеш, не джерело правди: розжалуваний адмін лишається адміном до `exp` свого access-токена
(до 10 хвилин). Це свідомий компроміс; якщо потрібно негайно — логаут його сімʼї (`revoked_at` + денилист)
діє одразу.

### Ротація ключа підпису без простою

Заголовок `kid` і keyring у `AccessTokens`: `JWT_PUBLIC_KEYS` — список `kid:ключ`, підписує лише пара
`JWT_KID`/`JWT_PRIVATE_KEY`. Ротація — три зміни конфігу без простою: (1) новий публічний ключ додається у
`JWT_PUBLIC_KEYS` **лише для верифікації** — обидва `kid` валідні; (2) `JWT_KID`/`JWT_PRIVATE_KEY` перемикаються
на новий ключ; (3) коли від перемикання минув `ACCESS_TTL_S` — старий `kid` прибирається зі списку. У цьому
вікні overlap жоден виданий токен не стає `401` без причини. На старті застосунок перевіряє, що `JWT_KID` є в
списку і що приватний ключ відповідає саме його публічному: переплутаний ключ падає на конфігу, а не `401` у
всіх клієнтів; у лог іде `signing key kid=… verifying kids=…`. Токен із невідомим `kid` відкидається одразу —
це і захист від підміни ключа, і сигнал, що ротація пройшла неправильно. `auth.e2e-spec.ts` ганяє застосунок
із keyring із двох `kid`: токен, підписаний другим ключем, проходить, той самий ключ під чужим `kid` — `401`.

### Демо

Кожне демо саме піднімає застосунок у своєму процесі (`src/redis/demo-api.ts`, порт `0`, закривається в
кінці), створює свіжих користувачів із випадковими паролями, друкує HTTP-статуси й перевіряє їх як інваріант.
`tampered` форжиться без ключа: payload токена з `role: admin` при старому підписі — рішення на
`jwt.decode()` віддало б тут `200`.

```
npm run demo:auth
login=200
no-token=401
with-token=200
refresh=200
rotated-access=200
logout=204
after-logout=401
old-access-after-logout=401
refresh-after-logout=401
relogin=200
```

```
npm run demo:reuse
login=200
r1-refresh=200
r1-reuse=401
r2-after-reuse=401
access-after-reuse=401
family-tokens=2
family-revoked=2
```

```
npm run demo:rbac
anon=401
own=200
foreign=403
role-denied=403
role-allowed=201
seller-foreign=403
tampered=401
```

Той самий сценарій живе e2e-тестами (`test/e2e/auth.e2e-spec.ts`): логін і `401`, логаут як дві дії,
детекція повтору з перевіркою `revoked_at` у всій сімʼї, `401` проти `403` на власності, ролі й підробленому
підписі, список замовлень лише своїх. Pact-верифікація провайдера (ДЗ #16) підкладає admin-токен через
`requestFilter` — контракт консюмера про автентифікацію не знає, і це нормально: він описує ресурси.

### Що лишилось за межами

- Сесії ДЗ #23 і JWT живуть поруч: `POST /sessions` тепер під bearer-токеном і створює сесію для його `sub`;
  власний IdP/OIDC — Лекція 25.
- Паролі seed-користувачів — `password` (дев-значення, не секрет): `seed.user1@example.com` — `admin`,
  `seed.user2`/`seed.user3` — `seller`, решта — `buyer`.
- ReBAC-кортежі (бонус) не робилися.


## Файли

Файли (фото товарів, аватарки, дампи з ДЗ #15) живуть не на диску інстанса, а в S3-сумісному обʼєктному
сховищі: локально — MinIO зі стенда, у проді — S3 або R2, змінюється лише `STORAGE_ENDPOINT`. API стоїть у
шляху **авторизації**, але не в шляху **даних**: байти йдуть із клієнта прямо в сховище за presigned URL і зі
сховища — через кеш-шар. Три властивості, які це доводять, — три демо: `demo:upload` (байти доїжджають, коли
API вимкнено), `demo:multipart` (після обриву доливається лише відсутня частина), `demo:cdn` (бакет закритий,
оновлення — під новим URL, інвалідацій нуль).

### Змінні

| Змінна | Джерело | Навіщо | Формат |
| --- | --- | --- | --- |
| `STORAGE_ENDPOINT` | `.env` (dev) / env оточення (prod) | адреса емулятора; порожньо означає AWS S3 | `http://localhost:9000` |
| `STORAGE_REGION` | `.env` / env оточення | регіон для SigV4 | `us-east-1` |
| `STORAGE_ACCESS_KEY` | сховище секретів (#11): локальний `.env` поза git, env платформи у проді | ключ доступу | рядок |
| `STORAGE_SECRET_KEY` | сховище секретів (#11) | секрет ключа — право читати й писати всі файли | рядок |
| `STORAGE_BUCKET` | `.env` / env оточення | приватний бакет для `uploads/` і `assets/` | `marketplace-files` |

Клієнт (`src/files/storage.ts`) — `S3Client` з `forcePathStyle`, коли заданий endpoint (емуляторам потрібно),
і `requestChecksumCalculation: 'WHEN_REQUIRED'`: SDK кінця 2024 рахує CRC32 для кожного завантаження за
замовчуванням, а presigned підписується, коли тіла ще немає — у query поїхала б сума порожніх даних. Дев-ключ
MinIO зі стенда (`marketplace` / `marketplace_dev`) не секрет, він і так у `docker-compose.yml`; продові ключі
їдуть зі сховища, як `DB_PASSWORD_FILE` і `JWT_PRIVATE_KEY`. Ціна витоку інша, ніж у `DATABASE_URL`: ключ
сховища — доступ до всіх файлів усіх користувачів, тому три демо йдуть через `scripts/with-secrets.sh dev`,
а в репозиторії жодного `.env` зі значеннями немає (критерії 2 і 6).

### Двокроковий контракт завантаження

`POST /uploads/intent` → клієнт кладе байти напряму у сховище → `POST /uploads/{id}/commit`
(`src/files/files.service.ts`).

- **intent** працює під `AuthGuard` з ДЗ #24, валідує `content_type` за allowlist (`image/jpeg`, `image/png`,
  `image/webp`, `application/pdf`, `application/octet-stream` — і в OpenAPI, і в коді) і сам генерує ключ
  `uploads/{userId}/{uuid}.{ext}`: розширення береться з allowlist за типом, `filename` клієнта нікуди не
  потрапляє — інакше клієнт отримав би право писати за довільним шляхом у бакеті (демо надсилає
  `../../etc/passwd` і перевіряє, що в ключі його немає). У базі зʼявляється рядок `files` зі статусом `pending`
  (міграція `Files`: `id, key UNIQUE, owner_id, content_type, size, status, upload_id, etag, created_at,
  completed_at`, частковий індекс по `created_at WHERE status = 'pending'` для чистки). Заголовок
  `Idempotency-Key` обовʼязковий (ДЗ #22): подвійний тап по «завантажити» повертає той самий `file_id` і ті самі
  URL з `Idempotency-Replay: true`, а не резервує другий обʼєкт; у відбиток ключа входить і власник, тож чужий
  замовник з тим самим ключем отримує `422`, а не чужий intent.
- **commit** робить `HeadObject` і звіряє, що обʼєкт існує і що розмір збігається з заявленим в intent; лише
  тоді `status = completed`, `etag` з відповіді сховища. Без цього клієнт «закомітив» би те, чого не заливав, —
  у демо це `commit-without-bytes=409`. Для multipart commit спершу перевіряє, що частин рівно стільки, скільки
  порахував план, і робить `CompleteMultipartUpload`; завершити «половину» не можна — `409`.
- **віддача** приватного файла — `GET /files/{id}` → `302` на presigned GET. Presigned не можна відкликати (ні
  `jti`, ні реєстру — з чотирьох стратегій ДЗ #24 працює лише короткий строк), тому в лист чи в UI іде не URL,
  а посилання на наш ендпоїнт: гард перевіряє власника на кожен запит, URL живе хвилину. У лог іде `file_id` і
  ключ обʼєкта, presigned URL — ніколи: рядок у access-лозі балансувальника дорівнював би виданому доступу.

### Строк presigned

`PUT_URL_TTL_S = 300`, `GET_URL_TTL_S = 60` (`src/files/upload-policy.ts`). Сценарій PUT — аватарка або фото
товару з форми: клієнт отримує URL і одразу вантажить; пʼять хвилин покривають повільну мобільну мережу й
повторну спробу після обриву, але URL із перехопленого запиту не живе годинами. Для multipart ті самі 300 с на
кожну частину — довгий файл не потребує довгого URL, бо клієнт просить свіжі URL на відсутні частини через
`GET /uploads/{id}/parts`. GET — 60 с: він видається у відповідь на запит, який уже пройшов гард, і клієнт іде за
ним негайно. Технічна межа SigV4 — 7 діб, але presigned помирає разом із креденшелами, якими підписаний: прод
ходить у сховище під роллю зі строком STS близько години, тож «7 днів» у проді й так дасть URL на годину. Що
протермінований URL дає `403`, демо перевіряє окремо (`expired=403`: підпис на 1 с, пауза 2,5 с); підпис накриває
шлях — підмінений ключ у тому ж URL дає `403 SignatureDoesNotMatch` (`tampered=403`).

### Multipart із довантаженням

Поріг і розмір частини пораховані, не вписані (`src/files/upload-policy.ts`): частин максимум 10 000, мінімум
5 МіБ на всі частини, крім останньої (інакше `EntityTooSmall`), тож
`partSize = max(5 МіБ, ceil(size / 10 000))`, округлений угору до МіБ, — файл на 100 ГБ отримує частини по
11 МіБ, а бібліотека з жорсткими 5 МіБ впала б уже на 50 ГБ. Поріг — `2 × 5 МіБ = 10 МіБ`: усе, що більше,
має щонайменше дві частини, інакше multipart вироджується в один PUT із трьома зайвими запитами. Для таких
файлів intent робить `CreateMultipartUpload` і підписує URL на кожну частину. Головне — відновлення: новий
процес викликає `GET /uploads/{id}/parts`, сервер питає сховище `ListParts` і повертає URL **лише** на частини,
яких бракує. Демо ріже 11 МіБ на 5 + 5 + 1, роняє клієнта `SIGKILL` після двох частин, і другий процес доливає
одну (`resumed-parts=1`); до Complete обʼєкта не існує (`HeadObject → 404`), хоча частини вже лежать; після —
розмір збігається, а ETag має суфікс `-3` і не є MD5 файла (`etag-is-md5=0`), тому код «порівняю ETag із
локальним MD5» на multipart ламався б мовчки.

### CDN перед сховищем, сховище закрите

Обрана форма — **локальний edge** (`src/files/edge.ts`, `npm run edge`): кілька десятків рядків `node:http`,
які беруть обʼєкт зі сховища власними креденшелами SDK, кладуть у памʼять і віддають із `X-Cache: HIT|MISS`.
Це і є суть OAC: до бакета ходить кеш, а не публіка. Бакет приватний (MinIO за замовчуванням: анонімний GET —
`403 AccessDenied`, `direct=403`), кеш читається анонімно. Edge кешує лише те, що origin дозволив кешувати:
без `Cache-Control` з `max-age` обʼєкт віддається, але не запамʼятовується — тому заголовок ставиться на
обʼєкт при завантаженні (`publishAsset`), а не в edge.

Справжня форма — CloudFront + Origin Access Control. Bucket policy для AWS-варіанту (Block Public Access
увімкнено, читати може лише сервіс CloudFront, і лише з **нашої** дистрибуції — без `Condition` з
`AWS:SourceArn` доступ мала б будь-яка дистрибуція у світі):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowOnlyOurCloudFrontDistribution",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::marketplace-files/assets/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE1234"
        }
      }
    }
  ]
}
```

Поведінка дистрибуції: origin — бакет із OAC (SigV4), behavior лише на `/assets/*`, cache policy шанує
`Cache-Control` origin-у, `uploads/` через CDN не роздається взагалі — приватні файли ідуть через
`GET /files/{id}`. Для приватного контенту через CDN планом є signed URL / signed cookies CloudFront — той самий
прийом «короткий строк замість відкликання», лише підпис ключем дистрибуції, а не бакета.

### Оновлення без інвалідації

Імʼя публічного ассета містить хеш вмісту: `assets/app.7321d6cd.css` (`assetKey` — перші 8 hex SHA-256 вмісту),
заголовок `Cache-Control: public, max-age=31536000, immutable`. «Деплой» нового вмісту — новий обʼєкт під новим
URL; старий запис у кеші нікому не заважає і доживає свій рік, інвалідацій — нуль (`new-name=1`,
`content-changed=1`, `old-url-still-hit=1`). AWS каже прямо: для файлів, що часто оновлюються, передусім
версіонування імен, а не інвалідація — інвалідація платна, повільна і не гарантує, що проміжні кеші й браузери
її побачили.

### Гігієна бакета

- **Незавершені multipart тарифікуються**, хоча обʼєкта немає: `npm run storage:init` разом із бакетом ставить
  lifecycle-правило `AbortIncompleteMultipartUpload: 7 днів`. MinIO цієї версії приймає правило лише у парі з
  дією `Expiration`, тому поруч стоїть безвідносний для неверсійного бакета `ExpiredObjectDeleteMarker: true`;
  на AWS та сама конфігурація валідна. Правило «видалити все старше N днів» таких хвостів не чіпає — це різні
  дії.
- **Файли-сироти**: intent без commit лишає рядок `pending` і, можливо, обʼєкт. `npm run prune` (ДЗ #22)
  добиває `pending` старші за добу: `AbortMultipartUpload` → `DeleteObject` → `DELETE` рядка
  (`src/files/abandoned.ts`), індекс `idx_files_pending_created_at` робить вибірку дешевою.
- **Список файлів живе в базі**, не у сховищі: листинг платний і по 1 000 ключів, демо чистять лише свій префікс.
- **Борг ДЗ #15**: бекап досі лягає в локальну теку; наступний крок — `uploads/`-подібний префікс `backups/` з
  lifecycle у холодний клас. Дві речі чесно: Glacier ламає RTO (обʼєкт треба спершу відновити), і lifecycle не
  робить бекап перевіреним — `restore-drill` нікуди не дівається.

### Демо

`npm run demo:upload`, `npm run demo:multipart`, `npm run demo:cdn` — кожне саме приводить стан до чистого
(свій користувач, свій префікс, `ListMultipartUploads → AbortMultipartUpload`, видалення своїх обʼєктів і рядків),
друкує `ключ=число` і завершується з кодом ≠ 0, якщо інваріант порушено. У `demo:upload` API піднімається в
процесі демо (`src/redis/demo-api.ts`), зупиняється перед PUT — живість порту перевіряється сирим сокетом
`net.connect`, не `fetch`, — PUT робить дочірній `node` з **порожнім** оточенням (жодного ключа), після чого API
піднімається знову на іншому порту (пул `fetch` тримає зʼєднання на парі host:port). Числа трьох прогонів
(локальний стенд і два прогони на чистій збірці) збігаються:

| Демо | Вивід |
| --- | --- |
| `demo:upload` | `intent=200 intent-replay=1 key-from-server=1 api-alive=0 put-offline=200 commit=200 size-match=1 commit-without-bytes=409 tampered=403 expired=403 download=302 download-bytes-match=1` |
| `demo:multipart` | `stale-uploads-aborted=0 intent=200 part-size=5242880 parts-planned=3 crash-signal=1 parts-after-crash=2 head-before-complete=404 resumed-parts=1 complete=200 size-match=1 etag-multipart=1 etag-is-md5=0` |
| `demo:cdn` | `direct=403 edge-miss=200 edge-hit=200 cache-hit=1 immutable-cache-control=1 new-name=1 new-url=200 content-changed=1 old-url-still-hit=1 invalidations=0` |

Формула одна на всі три механізми: коли скасувати дію дорого або неможливо, зроби так, щоб скасування було не
потрібне. Presigned не відкликається — тому короткий. Запис у CDN не дістати — тому URL версійний. Обрив не
попередити — тому завантаження відновлюване.

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=marketplace_a DB_PASSWORD=marketplace_dev DB_NAME=marketplace
export BROKER_URL=amqp://marketplace:marketplace_dev@127.0.0.1:5672
export REDIS_URL=redis://127.0.0.1:6379
export REDIS_QUEUE_URL=redis://127.0.0.1:6382
export STORAGE_ENDPOINT=http://127.0.0.1:9000
export STORAGE_ACCESS_KEY=marketplace
export STORAGE_SECRET_KEY=marketplace_dev
export STORAGE_BUCKET=marketplace-files
export SKIP_VAULT=1
# те самі база і роль для застосунку (npm run start / start:vault): URL без облікових даних + файл user:password
export DB_URL=postgres://127.0.0.1:6432/marketplace DB_PASSWORD_FILE=secrets/db_password.example
# одноразова пара ES256 для прогону; PEM їде в base64, щоб багаторядковість не поїхала
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs");
fs.writeFileSync("/tmp/priv.b64",Buffer.from(k.privateKey).toString("base64"));
fs.writeFileSync("/tmp/pub.b64",Buffer.from(k.publicKey).toString("base64"));'
export JWT_KID=grader
export JWT_PRIVATE_KEY="$(cat /tmp/priv.b64)"
export JWT_PUBLIC_KEYS="grader:$(cat /tmp/pub.b64)"
export REFRESH_TOKEN_PEPPER=grader-pepper-0123456789abcdef
npm ci && npm run build && npm run migrate && npm run events:topology && npm run storage:init
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

`DB_HOST`/`DB_PORT` — це PgBouncer (`127.0.0.1:6432`), не Postgres напряму. Пʼятірку `DB_*` читають скрипти
(міграції, seed, демо, бекап); сам застосунок (`npm run start`, `npm run start:vault`) читає `DB_URL` без
облікових даних і `DB_PASSWORD_FILE` (`src/config/env.schema.ts`), тому в блоці є й вони:
`secrets/db_password.example` — та сама дев-роль у форматі `user:password`. Дев-роль `marketplace_a` /
`marketplace_dev` створює `db/init.sql` при першому старті тому; секретом вона не є. Пароль ролей застосунку
можна задати змінною `DB_PASSWORD` під час першого `docker compose up` (compose передає її в
`APP_DB_PASSWORD`, `init.sql` читає її через `\set`) — так робить CI зі своїх secrets. `SKIP_VAULT=1`
потрібен, бо сховище грейдеру недоступне: обгортка тоді просто виконує команду з уже заданим оточенням.
`scripts/backup.sh` і `scripts/restore-drill.sh` читають `DB_*` прямо з оточення, тому після двох `export`
працює й форма без обгортки (`bash scripts/backup.sh`). `backup.sh` перевіряє `DB_HOST:DB_PORT` справжнім
підключенням: із неправильною адресою або портом він завершується з exit 1.

Бекап і drill у блоці йдуть після міграцій, тож drill порівнює справжню схему; одразу після `up` вони
проходять теж (схеми ще немає — drill чесно покаже `tables|0` і `MATCH`), а з `npm run seed` перед бекапом
порівнюються й дані.

Команди попередніх ДЗ працюють із тими самими `export`: `npm ci && npx tsc --noEmit`, `npm run build`,
`npm run migrate`, `npm run migrate:show`, `npm run migrate:revert`, `npm run seed && npm run seed`,
`npm run demo:nplus1`, `npm run report`; ДЗ #14 (після `migrate` і `seed`): `npm run demo:race`,
`npm run demo:workers`, `npm run demo:retry`. Міграції застосовуються на чисту базу: якщо в томі лишилась
схема з `db/schema.sql`, спершу `docker compose down -v`.

ДЗ #16 (потрібен лише запущений Docker, базу і RabbitMQ піднімає testcontainers): `npm ci && npx tsc --noEmit`,
`npm run test:integration`, `npm run test:e2e`, `npm run test:contract`, `npm run verify:provider`;
послідовність гейта з брокером — у «Тестування → Брокер локально і гейт can-i-deploy».

ДЗ #18 (застосунок піднятий за інструкцією з «Realtime», `localhost:3000`): команди з `curl` для SSE,
`Last-Event-ID` і два прогони `node scripts/realtime-demo.mjs` / `--same-room` — у тому ж розділі. З ДЗ #24
SSE-потік і REST-читання замовлень доступні лише з bearer-токеном власника (`401` без токена, `403` чужому);
скрипт демо логіниться seed-користувачами сам.

ДЗ #19 (після `npm run build && npm run migrate` з блоку вище; `seed` не потрібен — демо створюють свої дані):
`npm run demo:publish`, `npm run demo:dlq`, `npm run demo:duplicate`. `BROKER_URL` — AMQP-адреса RabbitMQ зі
стенда: схема `amqp`, порт `5672` (на `15672` — вебморда менеджменту, вона протоколом AMQP не відповідає).
Користувача `marketplace` / `marketplace_dev` створює compose через `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS`;
пароль можна задати змінною `BROKER_PASSWORD` при першому `docker compose up` — так робить CI. Статичні
перевірки (DLX і `prefetch` у коді, обгортка в `demo:*`, розділ `## Grading`, відсутність env-файлів із живими
URL) не потребують ні стенда, ні сховища.

ДЗ #22 (ті самі `export` і `npm ci && npm run build && npm run migrate` з блоку вище; `seed` не потрібен):
`npm run demo:outbox`, `npm run demo:crash-write`, `npm run demo:crash-relay`. Брокер — RabbitMQ зі стенда
(`BROKER_URL`, схема `amqp`, порт `5672`), база — `DB_*` через PgBouncer; relay і споживач демо запускають
самі дочірніми процесами, `npm start` для демо не потрібен.

ДЗ #23 (ті самі `export`; `seed` не потрібен): `npm run demo:cache`, `npm run demo:session`,
`npm run demo:ratelimit`, `npm run demo:queue`. `REDIS_URL` — кеш-інстанс (`redis-cache`, порт `6379`,
`allkeys-lru`), `REDIS_QUEUE_URL` — інстанс під чергу, сесії й ліміти (`redis-queue`, порт `6382`,
`noeviction`); обидва без пароля, як у compose. `demo:session` і `demo:ratelimit` піднімають API всередині
демо, тому їм потрібні і `BROKER_URL`, і `DB_*` з блоку вище; `demo:queue` відмовиться стартувати, якщо
паралельно запущений `npm run worker`. Топологію брокера демо оголошують самі, `events:topology` у блоці вище
потрібен лише для `npm start`.

ДЗ #24 (ті самі `export`): `npm run demo:auth`, `npm run demo:reuse`, `npm run demo:rbac`. Ключ підпису
грейдеру не потрібен — застосунку байдуже, чия пара, аби валідна, тому блок генерує одноразову ES256-пару на
місці; `REFRESH_TOKEN_PEPPER` — будь-який рядок від 16 байт. Голий `npm run start` без цих змінних падає з
exit 1 і називає їх (критерій 3), `npm run start:vault` бере їх зі сховища.

ДЗ #26 (ті самі `export`; `seed` не потрібен): `npm run demo:upload`, `npm run demo:multipart`, `npm run demo:cdn`.
`STORAGE_*` — MinIO зі стенда (`minio`, API на порту `9000`, консоль на `9001`, користувач `marketplace` /
`marketplace_dev` з compose; пароль можна задати змінною `STORAGE_PASSWORD` при першому `docker compose up`).
Образ — `bitnamilegacy/minio:2025.7.23-debian-12-r5` (MinIO RELEASE.2025-07-23): власний репозиторій `minio/minio`
на Docker Hub і quay.io восени 2026 перестав віддавати образи (`pull access denied`), а заморожений образ Bitnami
лишається публічним і мультиарх (amd64/arm64); сервер той самий, тому поведінка demo не змінюється.
Бакет створює `npm run storage:init` з блоку вище; демо на старті перевіряють його самі, тож і без цього кроку
проходять. `demo:upload` і `demo:multipart` піднімають API всередині демо, тому їм потрібні `DB_*`, `BROKER_URL`,
`REDIS_*` і ключі JWT з блоку вище; `demo:cdn` потребує лише `STORAGE_*`. Тип файла для multipart у демо —
`application/octet-stream` на 11 МіБ, тому серія не навантажує диск емулятора; дані MinIO лежать у томі
`miniodata`.

## Перевірки

Contract-тест консюмера (створює `pacts/*.json`):

```bash
npm run test:contract
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
