# Оптимізація запитів

Стенд: Postgres 17 у docker compose, ноутбук розробника, дані з `db/seed.sql`
(users 50 000, products 200 000, orders 300 000, order_items ≈600 000). Усі плани зняті
командою `EXPLAIN (ANALYZE, BUFFERS)` на чистій базі: «до» — одразу після `seed.sql`,
«після» — після `indexes.sql` та `ANALYZE`; для q4 узято третій прогін, бо перший іде
по холодному GIN. Seed використовує `random()`, тому цифри при відтворенні трохи відрізняються.

| Запит | Індекс з `db/indexes.sql` | До | Після |
| --- | --- | --- | --- |
| q1 замовлення користувача за період | `idx_orders_user_id_created_at` | 9.901 ms, 5 150 buffers | 0.289 ms, 61 buffers |
| q2 черга pending-замовлень | `idx_orders_pending_created_at` (partial) | 12.739 ms, 5 150 buffers | 0.329 ms, 102 buffers |
| q3 користувач за email без регістру | `idx_users_lower_email` (expression) | 10.366 ms, 608 buffers | 0.025 ms, 4 buffers |
| q4 повнотекстовий пошук по каталогу | `idx_products_search_vector` (GIN) | 23.049 ms, 12 598 buffers | 3.973 ms, 1 244 buffers |

## q1 — замовлення користувача за період

`db/queries/q1.sql`

### До індексів

```
                                                        QUERY PLAN                                                         
---------------------------------------------------------------------------------------------------------------------------
 Gather Merge  (cost=8577.26..8587.76 rows=90 width=29) (actual time=7.622..9.867 rows=52 loops=1)
   Workers Planned: 2
   Workers Launched: 2
   Buffers: shared hit=4561 read=589
   ->  Sort  (cost=7577.24..7577.35 rows=45 width=29) (actual time=5.604..5.605 rows=17 loops=3)
         Sort Key: created_at DESC
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=4561 read=589
         Worker 0:  Sort Method: quicksort  Memory: 25kB
         Worker 1:  Sort Method: quicksort  Memory: 25kB
         ->  Parallel Seq Scan on orders  (cost=0.00..7576.00 rows=45 width=29) (actual time=1.859..5.478 rows=17 loops=3)
               Filter: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
               Rows Removed by Filter: 99983
               Buffers: shared hit=4487 read=589
 Planning:
   Buffers: shared hit=100
 Planning Time: 0.341 ms
 Execution Time: 9.901 ms
(18 rows)
```

Планер читає всю таблицю `orders` (Parallel Seq Scan, 5 150 сторінок), відкидає 299 949 рядків фільтром і сортує 52, що лишились.

### Після індексів

```
                                                                  QUERY PLAN                                                                  
----------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=228.44..228.59 rows=60 width=29) (actual time=0.264..0.266 rows=52 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 27kB
   Buffers: shared hit=61
   ->  Bitmap Heap Scan on orders  (cost=5.04..226.67 rows=60 width=29) (actual time=0.034..0.242 rows=52 loops=1)
         Recheck Cond: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
         Heap Blocks: exact=51
         Buffers: shared hit=58
         ->  Bitmap Index Scan on idx_orders_user_id_created_at  (cost=0.00..5.03 rows=60 width=0) (actual time=0.020..0.020 rows=52 loops=1)
               Index Cond: ((user_id = 42) AND (created_at >= (now() - '180 days'::interval)))
               Buffers: shared hit=7
 Planning:
   Buffers: shared hit=138
 Planning Time: 0.388 ms
 Execution Time: 0.289 ms
(15 rows)
```

У план став `Bitmap Index Scan on idx_orders_user_id_created_at`: складений індекс `(user_id, created_at DESC)` відсікає і користувача, і період в Index Cond, тож замість 5 150 сторінок читаються 7 сторінок індексу та 51 сторінки купи з потрібними рядками; вузли Gather Merge і Parallel Seq Scan зникли, бо паралелити більше нічого.

## q2 — черга pending-замовлень

`db/queries/q2.sql`

### До індексів

```
                                                             QUERY PLAN                                                              
-------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=7873.42..7885.09 rows=100 width=32) (actual time=10.307..12.687 rows=100 loops=1)
   Buffers: shared hit=4655 read=495
   ->  Gather Merge  (cost=7873.42..9307.59 rows=12292 width=32) (actual time=10.304..12.678 rows=100 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=4655 read=495
         ->  Sort  (cost=6873.40..6888.76 rows=6146 width=32) (actual time=6.356..6.359 rows=79 loops=3)
               Sort Key: created_at
               Sort Method: top-N heapsort  Memory: 36kB
               Buffers: shared hit=4655 read=495
               Worker 0:  Sort Method: top-N heapsort  Memory: 37kB
               Worker 1:  Sort Method: top-N heapsort  Memory: 36kB
               ->  Parallel Seq Scan on orders  (cost=0.00..6638.50 rows=6146 width=32) (actual time=1.775..5.930 rows=4917 loops=3)
                     Filter: (status = 'pending'::text)
                     Rows Removed by Filter: 95083
                     Buffers: shared hit=4581 read=495
 Planning:
   Buffers: shared hit=92
 Planning Time: 1.000 ms
 Execution Time: 12.739 ms
(20 rows)
```

Статус `pending` має лише 5 % рядків, але без індексу планер сканує всі 300 000 (Parallel Seq Scan, 5 150 сторінок) і робить top-N сортування по `created_at`, щоб віддати перші 100.

### Після індексів

```
                                                                      QUERY PLAN                                                                       
-------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.29..141.65 rows=100 width=32) (actual time=0.013..0.315 rows=100 loops=1)
   Buffers: shared hit=102
   ->  Index Scan using idx_orders_pending_created_at on orders  (cost=0.29..20695.88 rows=14640 width=32) (actual time=0.013..0.310 rows=100 loops=1)
         Buffers: shared hit=102
 Planning:
   Buffers: shared hit=124
 Planning Time: 0.394 ms
 Execution Time: 0.329 ms
(8 rows)
```

У план став `Index Scan using idx_orders_pending_created_at`: partial-індекс містить тільки pending-рядки і вже впорядкований по `created_at`, тому Sort і Gather Merge зникли, а Limit зупиняє обхід після 100 записів — 102 сторінки замість 5 150.

## q3 — користувач за email без урахування регістру

`db/queries/q3.sql`

### До індексів

```
                                              QUERY PLAN                                              
------------------------------------------------------------------------------------------------------
 Seq Scan on users  (cost=0.00..1358.00 rows=250 width=55) (actual time=2.807..10.347 rows=1 loops=1)
   Filter: (lower(email) = 'user12345@example.com'::text)
   Rows Removed by Filter: 49999
   Buffers: shared hit=304 read=304
 Planning:
   Buffers: shared hit=82 read=2
 Planning Time: 0.309 ms
 Execution Time: 10.366 ms
(8 rows)
```

Умова `lower(email) = …` — функція над колонкою, тому індекс UNIQUE по `email` тут марний: Seq Scan по 608 сторінках і обчислення `lower()` для кожного з 50 000 рядків.

### Після індексів

```
                                                          QUERY PLAN                                                          
------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_users_lower_email on users  (cost=0.41..8.43 rows=1 width=55) (actual time=0.011..0.011 rows=1 loops=1)
   Index Cond: (lower(email) = 'user12345@example.com'::text)
   Buffers: shared hit=4
 Planning:
   Buffers: shared hit=104
 Planning Time: 0.283 ms
 Execution Time: 0.025 ms
(7 rows)
```

У план став `Index Scan using idx_users_lower_email`: expression-індекс зберігає вже обчислене `lower(email)`, умова стала Index Cond, і потрібний рядок знайдено за 4 сторінки замість 608.

## q4 — повнотекстовий пошук по каталогу

`db/queries/q4.sql`

### До індексів

```
                                                              QUERY PLAN                                                               
---------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=14565.44..14567.77 rows=20 width=49) (actual time=21.022..23.015 rows=20 loops=1)
   Buffers: shared hit=7531 read=5067
   ->  Gather Merge  (cost=14565.44..14691.68 rows=1082 width=49) (actual time=21.021..23.013 rows=20 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=7531 read=5067
         ->  Sort  (cost=13565.41..13566.77 rows=541 width=49) (actual time=19.305..19.306 rows=16 loops=3)
               Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
               Sort Method: top-N heapsort  Memory: 28kB
               Buffers: shared hit=7531 read=5067
               Worker 0:  Sort Method: top-N heapsort  Memory: 28kB
               Worker 1:  Sort Method: top-N heapsort  Memory: 28kB
               ->  Parallel Seq Scan on products  (cost=0.00..13551.02 rows=541 width=49) (actual time=0.133..19.063 rows=428 loops=3)
                     Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Rows Removed by Filter: 66239
                     Buffers: shared hit=7441 read=5067
 Planning:
   Buffers: shared hit=126
 Planning Time: 0.446 ms
 Execution Time: 23.049 ms
(20 rows)
```

Без GIN оператор `@@` перевіряється на кожному з 200 000 рядків: Parallel Seq Scan читає 12 598 сторінок, хоч збігів лише 1 283 (0.6 % каталогу).

### Після індексів

```
                                                                      QUERY PLAN                                                                      
------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=3995.19..3995.24 rows=20 width=49) (actual time=3.939..3.941 rows=20 loops=1)
   Buffers: shared hit=1244
   ->  Sort  (cost=3995.19..3998.53 rows=1337 width=49) (actual time=3.938..3.939 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 28kB
         Buffers: shared hit=1244
         ->  Bitmap Heap Scan on products  (cost=73.60..3959.61 rows=1337 width=49) (actual time=1.118..3.803 rows=1283 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=1222
               Buffers: shared hit=1238
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..73.26 rows=1337 width=0) (actual time=1.026..1.026 rows=1283 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=16
 Planning:
   Buffers: shared hit=151
 Planning Time: 0.476 ms
 Execution Time: 3.973 ms
(17 rows)
```

У план став `Bitmap Index Scan on idx_products_search_vector`: GIN за 16 сторінок віддає bitmap з 1 283 збігами, Bitmap Heap Scan читає лише 1 222 сторінок з цими рядками, далі top-N сортування за `ts_rank`; Seq Scan і Gather Merge зникли, buffers впали з 12 598 до 1 244.

## Ціна збереженої tsvector-колонки

`pg_total_relation_size('products')` після seed — 102 MB; та сама таблиця без `search_vector`
(копія через `CREATE TABLE … AS SELECT` без колонки) — 46 MB. Генерована STORED-колонка
подвоює таблицю і обчислює `to_tsvector` на кожному INSERT/UPDATE — це плата за те, що пошук
не треба підтримувати руками.

## Морфологія

Дві форми одного слова на тій самій базі:

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки');
-- 16328
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');
-- 0
```

Конфігурація `simple` не робить стемінгу, а лише приводить токени до нижнього регістру, тому
«кросівки» і «кросівок» — два різні токени, і родовий відмінок не знаходить нічого; серед 29
конфігурацій у `pg_ts_config` (`SELECT count(*) FROM pg_ts_config;`) української немає, а підміна
`simple` на `russian` дала б snowball-стемер для іншої мови, який лише вдавав би, що працює.
Справжнє рішення — hunspell-словник української, підключений як окрема text search configuration,
або зовнішній пошуковий рушій.
