# Marketplace API

ДЗ №1 (hw-09):

**Обраний варіант contract-частини: А (consumer-driven Pact).** Консюмер `marketplace-web`
у `test/consumer.pact.test.mjs` декларує очікування до `GET /orders/{id}`, «код фронта»
(`test/orders-client.mjs`) ганяється проти mock-провайдера, контракт пишеться у
`pacts/marketplace-web-marketplace-api.json`.

Сам сервер — NestJS, дані в Postgres через TypeORM-репозиторії (`src/entities/`, ДЗ #13); на кордоні стоїть
`express-openapi-validator` (запити й відповіді звіряються зі спекою, помилки віддаються як
`application/problem+json`).

## Вимоги

Node.js ≥ 22.12.0, Docker з Compose (для Postgres та образу).

## Запуск

```bash
npm install
cp .env.example .env
cp secrets/db_password.example secrets/db_password
npm run db:up
npm run build && npm run migrate && npm run seed
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
| `DB_URL` | так | — | URL **PgBouncer** (не Postgres напряму) **без облікових даних**, напр. `postgres://localhost:6432/marketplace` | сховище: локальний `.env` поза git (dev), env оточення платформи (prod) |
| `DB_PASSWORD_FILE` | так | — | шлях до файла-секрета формату `user:password`, напр. `secrets/db_password` | сховище: файл-секрет поза git, ротується `rotate.sh`; шаблон — `secrets/db_password.example` |

Контракт змінних — `.env.example` (у git). Реальний `.env` і тека `secrets/` — у `.gitignore`
та `.dockerignore`, у docker-образ вони не потрапляють.

Облікові дані БД застосунок читає не з env, а з файла `DB_PASSWORD_FILE` у форматі `user:password`:
пул `pg.Pool` створює зʼєднання через власний `Client`, який перечитує файл на кожне нове зʼєднання.
Тому і користувача, і пароль можна ротувати без рестарту.

Стенд для локального запуску — `docker-compose.yml`: Postgres (порт хоста `5433` — лише для прямого
адмін-доступу) і PgBouncer перед ним (порт хоста `6432` — сюди ходить застосунок, див. «Data layer ops»;
`npm run db:up` чекає на healthcheck обох сервісів, тож `npm run db:up && npm start` не
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
| `/orders` | `GET /orders` (cursor-пагінація), `POST /orders` (Idempotency-Key), `GET /orders/{id}` |

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
(`NO SPEC` / `ORPHAN`). Він виконується у CI (`.github/workflows/ci.yml`: `docker compose up -d --wait` → міграції
крізь PgBouncer → `check:indexes` → seed двічі → три демо конкурентності → бекап → restore-drill → Pact →
lint спеки). Сам workflow локально не запускався.

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

Піднімає Postgres 17 і PgBouncer 1.26 (`edoburu/pgbouncer`), чекає healthcheck обох. Healthcheck пулера —
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

Або `npm run backup`. Скрипт бере `DB_USER`, `DB_PASSWORD`, `DB_NAME` з оточення, яке наповнює обгортка зі
сховища ДЗ #11, і запускає `pg_dump -Fc` усередині контейнера Postgres (версія клієнта завжди збігається
із сервером), підключаючись до Postgres напряму по TCP з перевіркою пароля. Результат —
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

Розклад — `backup.cron`: щоночі о 03:00 через ту саму обгортку, лог у `backups/backup.log`.

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

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=marketplace_a DB_PASSWORD=marketplace_dev DB_NAME=marketplace
export SKIP_VAULT=1
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

`DB_HOST`/`DB_PORT` — це PgBouncer (`127.0.0.1:6432`), не Postgres напряму; у формі URL це
`postgres://marketplace_a:marketplace_dev@127.0.0.1:6432/marketplace`. Дев-роль `marketplace_a` /
`marketplace_dev` створює `db/init.sql` при першому старті тому; секретом вона не є. `SKIP_VAULT=1`
потрібен, бо сховище грейдеру недоступне: обгортка тоді просто виконує команду з уже заданим оточенням.
`scripts/backup.sh` і `scripts/restore-drill.sh` читають `DB_*` прямо з оточення, тому після двох `export`
працює й форма без обгортки (`bash scripts/backup.sh`).

Бекап і drill проходять одразу після `up` (схеми ще немає — drill чесно покаже `tables|0` і `MATCH`).
Щоб drill порівнював справжні дані, перед бекапом застосуйте міграції й seed:
`npm ci && npm run build && npm run migrate && npm run seed`.

Команди попередніх ДЗ працюють із тими самими `export`: `npm ci && npx tsc --noEmit`, `npm run build`,
`npm run migrate`, `npm run migrate:show`, `npm run migrate:revert`, `npm run seed && npm run seed`,
`npm run demo:nplus1`, `npm run report`; ДЗ #14 (після `migrate` і `seed`): `npm run demo:race`,
`npm run demo:workers`, `npm run demo:retry`. Міграції застосовуються на чисту базу: якщо в томі лишилась
схема з `db/schema.sql`, спершу `docker compose down -v`.

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
