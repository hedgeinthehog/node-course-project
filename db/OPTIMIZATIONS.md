# Оптимізація запитів

Стенд: Postgres 17 у docker compose, ноутбук розробника, дані з `db/seed.sql`
(users 50 000, products 200 000, orders 300 000, order_items ≈600 000). Усі плани зняті
командою `EXPLAIN (ANALYZE, BUFFERS)` за один прогін на чистій базі: «до» — одразу після `seed.sql`,
«після» — після `indexes.sql` та `ANALYZE`; для кожного запиту узято третій прогін, бо перший
після `CREATE INDEX` іде по холодному індексу. Seed використовує `random()`, тому цифри при
відтворенні трохи відрізняються.

| Запит | Індекс з `db/indexes.sql` | До | Після |
| --- | --- | --- | --- |
| q1 замовлення користувача за період | `idx_orders_user_id_created_at` | 10.164 ms, 5 079 buffers | 0.288 ms, 56 buffers |
| q2 черга pending-замовлень | `idx_orders_pending_created_at` (partial + INCLUDE) | 25.056 ms, 5 150 buffers | 0.139 ms, 3 buffers |
| q3 користувач за email без регістру | `idx_users_lower_email` (expression) | 13.201 ms, 608 buffers | 0.060 ms, 4 buffers |
| q4 повнотекстовий пошук по каталогу | `idx_products_search_vector` (GIN) | 33.054 ms, 12 597 buffers | 5.191 ms, 1 313 buffers |

## q1 — замовлення користувача за період

`db/queries/q1.sql`

### До індексів

```
                                                        QUERY PLAN                                                        
--------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=8576.44..8576.45 rows=4 width=29) (actual time=8.291..10.126 rows=47 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 27kB
   Buffers: shared hit=5079
   ->  Gather  (cost=1000.00..8576.40 rows=4 width=29) (actual time=0.206..10.098 rows=47 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=5076
         ->  Parallel Seq Scan on orders  (cost=0.00..7576.00 rows=2 width=29) (actual time=1.367..6.437 rows=16 loops=3)
               Filter: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
               Rows Removed by Filter: 99984
               Buffers: shared hit=5076
 Planning:
   Buffers: shared hit=104
 Planning Time: 0.502 ms
 Execution Time: 10.164 ms
(16 rows)
```

Планер читає всю таблицю `orders` (Parallel Seq Scan, 5 079 сторінок), відкидає 299 952 рядків фільтром і сортує 47, що лишились.

### Після індексів

```
                                                                  QUERY PLAN                                                                  
----------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=156.05..156.15 rows=40 width=29) (actual time=0.250..0.257 rows=47 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 27kB
   Buffers: shared hit=56
   ->  Bitmap Heap Scan on orders  (cost=4.84..154.99 rows=40 width=29) (actual time=0.052..0.223 rows=47 loops=1)
         Recheck Cond: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
         Heap Blocks: exact=47
         Buffers: shared hit=53
         ->  Bitmap Index Scan on idx_orders_user_id_created_at  (cost=0.00..4.83 rows=40 width=0) (actual time=0.026..0.026 rows=47 loops=1)
               Index Cond: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
               Buffers: shared hit=6
 Planning:
   Buffers: shared hit=147
 Planning Time: 0.409 ms
 Execution Time: 0.288 ms
(15 rows)
```

У план став `Bitmap Index Scan on idx_orders_user_id_created_at`: складений індекс `(user_id, created_at DESC)` відсікає і користувача, і період в Index Cond, тож замість 5 079 сторінок читаються 6 сторінок індексу та 47 сторінок купи з потрібними рядками; вузли Gather Merge і Parallel Seq Scan зникли, бо паралелити більше нічого.

## q2 — черга pending-замовлень

`db/queries/q2.sql`

### До індексів

```
                                                              QUERY PLAN                                                              
--------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=7868.15..7879.81 rows=100 width=32) (actual time=22.654..25.000 rows=100 loops=1)
   Buffers: shared hit=5150
   ->  Gather Merge  (cost=7868.15..9270.11 rows=12016 width=32) (actual time=22.652..24.989 rows=100 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=5150
         ->  Sort  (cost=6868.12..6883.14 rows=6008 width=32) (actual time=14.642..14.646 rows=79 loops=3)
               Sort Key: created_at
               Sort Method: top-N heapsort  Memory: 36kB
               Buffers: shared hit=5150
               Worker 0:  Sort Method: top-N heapsort  Memory: 37kB
               Worker 1:  Sort Method: top-N heapsort  Memory: 36kB
               ->  Parallel Seq Scan on orders  (cost=0.00..6638.50 rows=6008 width=32) (actual time=0.694..13.780 rows=5025 loops=3)
                     Filter: (status = 'pending'::text)
                     Rows Removed by Filter: 94975
                     Buffers: shared hit=5076
 Planning:
   Buffers: shared hit=92
 Planning Time: 0.447 ms
 Execution Time: 25.056 ms
(20 rows)
```

Статус `pending` має лише 5 % рядків, але без індексу планер сканує всі 300 000 (Parallel Seq Scan, 5 150 сторінок) і робить top-N сортування по `created_at`, щоб віддати перші 100.

### Після індексів

```
                                                                        QUERY PLAN                                                                        
----------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.29..4.18 rows=100 width=32) (actual time=0.081..0.091 rows=100 loops=1)
   Buffers: shared hit=3
   ->  Index Only Scan using idx_orders_pending_created_at on orders  (cost=0.29..604.78 rows=15500 width=32) (actual time=0.080..0.086 rows=100 loops=1)
         Heap Fetches: 0
         Buffers: shared hit=3
 Planning:
   Buffers: shared hit=133
 Planning Time: 0.638 ms
 Execution Time: 0.139 ms
(9 rows)
```

У план став `Index Only Scan using idx_orders_pending_created_at`: partial-індекс містить тільки pending-рядки, вже впорядкований по `created_at`, а `INCLUDE (id, user_id, total_cents)` кладе в листки всі чотири колонки запиту, тому Sort і Gather Merge зникли, у купу планер не ходить зовсім (`Heap Fetches: 0`, бо `VACUUM` у seed виставив visibility map) — 3 сторінки замість 5 150. Без INCLUDE той самий індекс давав Index Scan і ~100 сторінок купи заради 100 рядків.

## q3 — користувач за email без урахування регістру

`db/queries/q3.sql`

### До індексів

```
                                              QUERY PLAN                                              
------------------------------------------------------------------------------------------------------
 Seq Scan on users  (cost=0.00..1358.00 rows=250 width=55) (actual time=2.879..13.176 rows=1 loops=1)
   Filter: (lower(email) = 'user12345@example.com'::text)
   Rows Removed by Filter: 49999
   Buffers: shared read=608 written=191
 Planning:
   Buffers: shared hit=88
 Planning Time: 0.371 ms
 Execution Time: 13.201 ms
(8 rows)
```

Умова `lower(email) = …` — функція над колонкою, тому індекс UNIQUE по `email` тут марний: Seq Scan по 608 сторінках і обчислення `lower()` для кожного з 50 000 рядків.

### Після індексів

```
                                                          QUERY PLAN                                                          
------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_users_lower_email on users  (cost=0.41..8.43 rows=1 width=55) (actual time=0.019..0.019 rows=1 loops=1)
   Index Cond: (lower(email) = 'user12345@example.com'::text)
   Buffers: shared hit=4
 Planning:
   Buffers: shared hit=104
 Planning Time: 0.494 ms
 Execution Time: 0.060 ms
(7 rows)
```

У план став `Index Scan using idx_users_lower_email`: expression-індекс зберігає вже обчислене `lower(email)`, умова стала Index Cond, і потрібний рядок знайдено за 4 сторінки замість 608.

## q4 — повнотекстовий пошук по каталогу

`db/queries/q4.sql`

### До індексів

```
                                                              QUERY PLAN                                                               
---------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=14564.58..14566.92 rows=20 width=49) (actual time=30.932..32.996 rows=20 loops=1)
   Buffers: shared hit=7542 read=5055 written=14
   ->  Gather Merge  (cost=14564.58..14691.99 rows=1092 width=49) (actual time=30.930..32.993 rows=20 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=7542 read=5055 written=14
         ->  Sort  (cost=13564.56..13565.93 rows=546 width=49) (actual time=29.165..29.165 rows=15 loops=3)
               Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
               Sort Method: top-N heapsort  Memory: 28kB
               Buffers: shared hit=7542 read=5055 written=14
               Worker 0:  Sort Method: top-N heapsort  Memory: 28kB
               Worker 1:  Sort Method: top-N heapsort  Memory: 28kB
               ->  Parallel Seq Scan on products  (cost=0.00..13550.03 rows=546 width=49) (actual time=0.230..28.923 rows=445 loops=3)
                     Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Rows Removed by Filter: 66222
                     Buffers: shared hit=7452 read=5055 written=14
 Planning:
   Buffers: shared hit=117 read=13
 Planning Time: 1.231 ms
 Execution Time: 33.054 ms
(20 rows)
```

Без GIN оператор `@@` перевіряється на кожному з 200 000 рядків: Parallel Seq Scan читає 12 597 сторінок, хоч збігів лише 1 335 (0.7 % каталогу).

### Після індексів

```
                                                                      QUERY PLAN                                                                      
------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=3963.70..3963.75 rows=20 width=49) (actual time=5.071..5.073 rows=20 loops=1)
   Buffers: shared hit=1313
   ->  Sort  (cost=3963.70..3967.01 rows=1324 width=49) (actual time=5.070..5.071 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 28kB
         Buffers: shared hit=1313
         ->  Bitmap Heap Scan on products  (cost=73.53..3928.47 rows=1324 width=49) (actual time=1.054..4.919 rows=1335 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=1291
               Buffers: shared hit=1307
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..73.20 rows=1324 width=0) (actual time=0.967..0.967 rows=1335 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=16
 Planning:
   Buffers: shared hit=151
 Planning Time: 0.509 ms
 Execution Time: 5.191 ms
(17 rows)
```

У план став `Bitmap Index Scan on idx_products_search_vector`: GIN за 16 сторінок віддає bitmap з 1 335 збігами, Bitmap Heap Scan читає лише 1 291 сторінок з цими рядками, далі top-N сортування за `ts_rank`; Seq Scan і Gather Merge зникли, buffers впали з 12 597 до 1 313.

## Ціна збереженої tsvector-колонки

`pg_total_relation_size('products')` після seed — 102 MB; та сама таблиця без `search_vector`
(копія через `CREATE TABLE … AS SELECT` без колонки) — 46 MB. Генерована STORED-колонка
подвоює таблицю і обчислює `to_tsvector` на кожному INSERT/UPDATE — це плата за те, що пошук
не треба підтримувати руками.

## Морфологія

Дві форми одного слова на тій самій базі:

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки');
-- 16217
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');
-- 0
```

Конфігурація `simple` не робить стемінгу, а лише приводить токени до нижнього регістру, тому
«кросівки» і «кросівок» — два різні токени, і родовий відмінок не знаходить нічого; серед 29
конфігурацій у `pg_ts_config` (`SELECT count(*) FROM pg_ts_config;`) української немає, а підміна
`simple` на `russian` дала б snowball-стемер для іншої мови, який лише вдавав би, що працює.
Справжнє рішення — hunspell-словник української, підключений як окрема text search configuration,
або зовнішній пошуковий рушій.
