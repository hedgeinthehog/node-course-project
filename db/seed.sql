SET ROLE marketplace;

INSERT INTO users (email, name, created_at)
SELECT
  'user' || g || '@example.com',
  'Користувач ' || g,
  now() - (random() * interval '730 days')
FROM generate_series(1, 50000) AS g;

INSERT INTO products (seller_id, name, description, price_cents, status, created_at)
SELECT
  1 + floor(power(random(), 3) * 50000)::int,
  adj[1 + floor(random() * 24)::int] || ' ' || noun[1 + floor(random() * 24)::int] || ' ' || brand[1 + floor(random() * 12)::int],
  'Якісні ' || adj[1 + floor(random() * 24)::int] || ' ' || noun[1 + floor(random() * 24)::int]
    || ' для ' || purpose[1 + floor(random() * 8)::int] || '. Колір ' || color[1 + floor(random() * 10)::int]
    || ', гарантія ' || (1 + floor(random() * 3)::int) || ' роки.',
  (100 + floor(power(random(), 2) * 500000))::int,
  CASE WHEN random() < 0.92 THEN 'active' ELSE 'archived' END,
  now() - (random() * interval '730 days')
FROM generate_series(1, 200000) AS g,
  (SELECT
    ARRAY['шкіряні', 'бавовняні', 'дитячі', 'спортивні', 'зимові', 'літні', 'чоловічі', 'жіночі',
          'бездротові', 'ігрові', 'офісні', 'туристичні', 'класичні', 'легкі', 'теплі', 'водонепроникні',
          'компактні', 'розумні', 'вінтажні', 'преміальні', 'домашні', 'вуличні', 'універсальні', 'яскраві'] AS adj,
    ARRAY['кросівки', 'сумка', 'ноутбук', 'куртка', 'навушники', 'футболка', 'смартфон', 'рюкзак',
          'годинник', 'черевики', 'планшет', 'джинси', 'светр', 'намет', 'велосипед', 'окуляри',
          'клавіатура', 'монітор', 'пальто', 'кепка', 'шарф', 'лампа', 'крісло', 'валіза'] AS noun,
    ARRAY['Nova', 'Dnipro', 'Karpaty', 'Lviv', 'Sich', 'Polissia', 'Azov', 'Desna', 'Bukovyna', 'Tavria', 'Volyn', 'Halych'] AS brand,
    ARRAY['щоденного використання', 'подорожей', 'спорту', 'роботи', 'навчання', 'відпочинку', 'подарунка', 'дому'] AS purpose,
    ARRAY['чорний', 'білий', 'сірий', 'синій', 'зелений', 'червоний', 'бежевий', 'коричневий', 'бордовий', 'жовтий'] AS color
  ) AS words;

INSERT INTO orders (user_id, status, total_cents, created_at)
SELECT
  1 + floor(power(random(), 2) * 50000)::int,
  CASE WHEN r < 0.05 THEN 'pending' WHEN r < 0.90 THEN 'paid' ELSE 'cancelled' END,
  0,
  now() - (power(random(), 2) * interval '730 days')
FROM (SELECT random() AS r FROM generate_series(1, 300000)) AS x;

INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
SELECT DISTINCT ON (pick.order_id, p.id)
  pick.order_id,
  p.id,
  1 + floor(power(random(), 3) * 4)::int,
  p.price_cents
FROM (
  SELECT
    o.id AS order_id,
    1 + floor(power(random(), 2) * 200000)::int AS product_id
  FROM orders AS o
  CROSS JOIN LATERAL generate_series(1, 1 + (o.id % 3)::int) AS n
) AS pick
JOIN products AS p ON p.id = pick.product_id;

UPDATE orders AS o
SET total_cents = t.total
FROM (
  SELECT order_id, sum(quantity * unit_price_cents) AS total
  FROM order_items
  GROUP BY order_id
) AS t
WHERE t.order_id = o.id;

VACUUM (ANALYZE) users, products, orders, order_items;
