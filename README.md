# Marketplace API

ДЗ №1 (hw-09):

**Обраний варіант contract-частини: А (consumer-driven Pact).** Консюмер `marketplace-web`
у `test/contract/consumer.pact-spec.ts` декларує очікування до `GET /orders/{id}` і `POST /orders`, «код фронта»
(`test/contract/orders-client.ts`) ганяється проти mock-провайдера, контракт пишеться у
`pacts/marketplace-web-marketplace-api.json`. З ДЗ #16 цей контракт ще й верифікується проти справжнього
застосунку (розділ «Тестування»).

Сам сервер — NestJS, дані в Postgres через TypeORM-репозиторії (`src/entities/`, ДЗ #13); на кордоні стоїть
`express-openapi-validator` (запити й відповіді звіряються зі спекою, помилки віддаються як
`application/problem+json`). Події домену йдуть у RabbitMQ (ДЗ #19, розділ «Async-події через RabbitMQ»).

## Вимоги

Node.js ≥ 22.12.0, Docker з Compose (для Postgres, RabbitMQ, образу й тестів на testcontainers).

## Запуск

```bash
npm install
cp .env.example .env
cp secrets/db_password.example secrets/db_password
npm run db:up
npm run build && npm run migrate && npm run events:topology && npm run seed
npm start
```

Сервер слухає `http://localhost:3000`. Споживач подій `order.placed` — окремий процес, у другому терміналі
(він же оголошує топологію брокера при старті, тож `events:topology` потрібен лише щоб API стартував раніше за
споживача):

```bash
npm run consume
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
Pact Broker (`9292`, див. «Тестування») і RabbitMQ 4.2 (`5672` — AMQP, `15672` — вебморда менеджменту; healthcheck
— `rabbitmq-diagnostics -q check_running`, бо між відкриттям TCP-порту і готовністю Erlang-ноди приймати
`basic.publish` є вікно, у якому клієнт ловить `ECONNRESET`). `npm run db:up` чекає на healthcheck усіх сервісів,
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

- **Cursor-пагінація**: `?limit=&cursor=`, відповідь `{ items, next_cursor }`, `next_cursor: null` — сторінок більше немає. Курсор — непрозорий токен.
- **Idempotency-Key**: обовʼязковий header на обох POST. Той самий ключ + те саме тіло → та сама відповідь `201` + `Idempotency-Replay: true`; той самий ключ + інше тіло → `422`.
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
3. `INSERT` у `orders`, `order_items` і задача `order_confirmation` у `tasks`.

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

Розклад — `backup.cron`: щоночі о 03:00 через ту саму обгортку, лог у `backups/backup.log`. Рядок сам
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
брокер і `can-i-deploy`. Потрібен лише запущений Docker: Postgres і RabbitMQ для тестів піднімає testcontainers,
compose для перших чотирьох команд не потрібен.

| Команда | Що запускає | Результат прогону |
| --- | --- | --- |
| `npm run test:integration` | `test/integration/` — репозиторії, checkout, воркер, споживач `order.placed` проти Postgres і RabbitMQ у testcontainers | 5 наборів, 20 тестів |
| `npm run test:e2e` | `test/e2e/` — повний `AppModule` через supertest: замовлення, realtime, публікація `order.placed` | 10 тестів |
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
`TRUNCATE` семи малих таблиць — мілісекунди. Повторний запуск зелений без чистки: кожен прогін отримує
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
| `order-placed-consumer.int-spec.ts` | справжній RabbitMQ: дубль події → один рядок `shipments`; ефект, що падає → три повтори через retry-чергу з паузою і DLQ з `rejected`; повідомлення поза контрактом → DLQ з `rejected` без повторів; crash-loop (`requeue` × 4) → DLQ з `delivery_limit` (ДЗ #19) |
| `test/e2e/orders.e2e-spec.ts` | створити товар → оформити замовлення → прочитати обидва → повтор з тим самим `Idempotency-Key`; `400` без ключа, `404` на невідоме замовлення, `409` при нестачі товару; `POST /orders` публікує `order.placed` рівно один раз, повтор за ключем — не публікує (ДЗ #19) |
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

`.github/workflows/ci.yml`: job `db` — compose-стенд (Postgres, PgBouncer, RabbitMQ), міграції, демо ДЗ #14 і
ДЗ #19, бекап і drill; job `tests` — `test:integration` і `test:e2e`; job `contract` — pipeline контракту,
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
(`DB_PASSWORD`, `BROKER_PASSWORD`; за замовчуванням — дев-значення стенда). Workflow локально не запускався.

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
  `auth: { userId }` і шле `join` з `{ orderId }`. Сервер кладе сокет у кімнату `orders:<id>` і відповідає
  ack `{ ok: true, room }` лише якщо замовлення належить цьому користувачу; анонімному або чужому guard
  відмовляє — клієнт отримує подію `exception` з `{ ok: false, error: 'unauthenticated' | 'forbidden' }`
  (так Nest доставляє відмову guard-а в socket.io), ack не приходить. Подія `order.status` емітиться через
  `server.to('orders:<id>')`, тобто тільки в кімнату цього замовлення.
- **SSE** — `GET /orders/{id}/events` із заголовком `X-User-Id` власника, `content-type:
  text/event-stream`. Потік починається з `retry: 1000`, кожна подія — блок `event: order.status`,
  `id: <seq>`, `data: <OrderStatusEvent JSON>`; раз на 15 секунд іде коментар `: ping`. Нове підключення
  без `Last-Event-ID` отримує всі збережені події замовлення, реконект із `Last-Event-ID: N` — лише події
  з `seq > N`, далі живі; номери ті самі й після рестарту застосунку. Підписка на живі події відкривається
  **до** читання історії з бази, тож подія, що сталася між читанням і підпискою, не губиться, а дублікати
  відсікаються за номером.

Перевірка власника для обох транспортів — один `OrderOwnerGuard` (`src/orders/order-owner.guard.ts`,
`@UseGuards` і на `join`, і на SSE-маршруті): він бере id користувача з `handshake.auth.userId` або з
заголовка `X-User-Id`, id замовлення — з тіла `join` або з шляху, і порівнює з `orders.user_id`. Поки в API
немає автентифікації (вона з'явиться на Лекції 24), користувач називає себе сам — так само, як `user_id` у
тілі `POST /orders`; після появи сесії guard братиме id з неї, а не з заголовка. Без `X-User-Id` SSE-запит
відхиляє валідатор спеки (`400`, заголовок обовʼязковий у `openapi.yaml`), чужому — `403`, невідоме
замовлення — `404`, усе до відкриття потоку. `GET /orders/{id}` і решта REST-читань лишаються відкритими,
як у контракті ДЗ #9, — це свідомо відкладено до справжньої автентифікації.

Запуск і перевірка (застосунок на `http://localhost:3000`; перші два рядки — локальне сховище з ДЗ #11,
пропустіть їх, якщо `.env` і `secrets/db_password` уже є):

```bash
cp .env.example .env
cp secrets/db_password.example secrets/db_password
npm ci && npm run db:up && npm run build && npm run migrate && npm run events:topology && npm run seed && npm start
```

У другому терміналі створіть замовлення й змінюйте статус:

```bash
curl -s -X POST localhost:3000/orders -H 'Content-Type: application/json' -H "Idempotency-Key: order-$(date +%s)" -d '{"user_id":1,"items":[{"product_id":2,"quantity":1}]}'
```

```bash
for s in processing shipped out_for_delivery delivered; do curl -s -X PATCH localhost:3000/orders/<id>/status -H 'Content-Type: application/json' -d "{\"status\":\"$s\"}"; echo; done
```

SSE-заголовок, формат подій і відновлення після `Last-Event-ID: 3` (чотири зміни вище дають події 1..4,
тож перший `id:` у відповіді — `4`). `X-User-Id: 1` — власник замовлення, створеного командою вище; без
цього заголовка відповідь — `400` problem+json, із чужим id — `403`:

```bash
curl -sN --max-time 2 -H 'X-User-Id: 1' -D - -o /dev/null localhost:3000/orders/<id>/events | grep -i '^content-type'
```

```bash
curl -sN --max-time 5 -H 'X-User-Id: 1' localhost:3000/orders/<id>/events
```

```bash
curl -sN --max-time 2 -H 'X-User-Id: 1' -H 'Last-Event-ID: 3' localhost:3000/orders/<id>/events | grep '^id:' | head -1
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

Подія виходить із бізнес-операції: `OrdersService.create` після коміту checkout публікує її через
`EventPublisher` (`src/events/publisher.ts`) — confirm-канал (`createConfirmChannel`), `persistent: true`,
`messageId = eventId`, `waitForConfirms()` до відповіді клієнту. Ідемпотентний повтор `POST /orders` з тим самим
`Idempotency-Key` не публікує вдруге (E2E-тест). Між COMMIT і publish є щілина: якщо брокер недоступний саме тут,
замовлення вже існує, а події немає — клієнт отримує `503`, повтор із тим самим ключем повертає `201` із
замовленням, але подію до появи transactional outbox (ДЗ #22) доведеться відновлювати вручну. Якщо exchange не
оголошено, API не стартує (помилка з підказкою `npm run events:topology`), а не губить події в нікуди. Після
обриву зʼєднання з брокером наступна публікація перепідключається сама; `/health` стан брокера не перевіряє —
збій видно на публікації (`503`).

### Споживач

`npm run consume` → `src/consumer.ts` (у контейнері — той самий образ із командою `node dist/consumer.js`);
бібліотечна частина — `src/events/consumer.ts`:

- `noAck: false`, `channel.ack` — **після** ефекту. `prefetch=20` (константа `PREFETCH`): ефект — один `INSERT`
  на 2–5 мс, 20 × 5 мс = 0,1 с ≪ `consumer_timeout` 30 хв; `prefetch=1` для 2-мілісекундної роботи — зайвий
  round-trip на кожне повідомлення, а дефолтний 0 — перший споживач забирає всю чергу, другий простоює.
- Ефект — створити відправлення: `INSERT INTO shipments (order_id, event_id) … ON CONFLICT (order_id) DO NOTHING
  RETURNING order_id` (міграція `Shipments`): природний ключ бізнес-операції, порожній `RETURNING` → дубль, ефект
  пропущено. Сховище — та сама Postgres, тому дедуп переживає рестарт і працює між інстансами; `Set` у памʼяті
  тут не рахувався б.
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

Щілини між «позначив оброблене» і «застосував ефект» тут немає — позначка і є ефектом (один `INSERT`); а от між
ефектом і `ack` вона є, саме її показує `demo:duplicate`. Закривається вона не меншою щілиною, а спільною
транзакцією позначки й ефекту (ДЗ #22).

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

`npm run demo:publish` — пʼять checkout → пʼять `order.placed` у чергу **до** старту споживача (`queued=5`:
брокер зберігає до появи одержувача), далі споживач забирає все:

```
published=5
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
- Transactional outbox (база і брокер атомарно) і `processed_messages` в одній транзакції з ефектом — ДЗ #22;
  Redis і BullMQ поверх тієї ж події — ДЗ #23.


## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=marketplace_a DB_PASSWORD=marketplace_dev DB_NAME=marketplace
export BROKER_URL=amqp://marketplace:marketplace_dev@127.0.0.1:5672
export SKIP_VAULT=1
npm ci && npm run build && npm run migrate
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

`DB_HOST`/`DB_PORT` — це PgBouncer (`127.0.0.1:6432`), не Postgres напряму; у формі URL це
`postgres://marketplace_a:marketplace_dev@127.0.0.1:6432/marketplace`. Дев-роль `marketplace_a` /
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
`Last-Event-ID` і два прогони `node scripts/realtime-demo.mjs` / `--same-room` — у тому ж розділі. SSE-потік
віддається лише власнику: у `curl` потрібен `-H 'X-User-Id: <user_id замовлення>'` (для замовлення з
прикладу — `1`), без нього — `400`.

ДЗ #19 (після `npm run build && npm run migrate` з блоку вище; `seed` не потрібен — демо створюють свої дані):
`npm run demo:publish`, `npm run demo:dlq`, `npm run demo:duplicate`. `BROKER_URL` — AMQP-адреса RabbitMQ зі
стенда: схема `amqp`, порт `5672` (на `15672` — вебморда менеджменту, вона протоколом AMQP не відповідає).
Користувача `marketplace` / `marketplace_dev` створює compose через `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS`;
пароль можна задати змінною `BROKER_PASSWORD` при першому `docker compose up` — так робить CI. Статичні
перевірки (DLX і `prefetch` у коді, обгортка в `demo:*`, розділ `## Grading`, відсутність env-файлів із живими
URL) не потребують ні стенда, ні сховища.

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
