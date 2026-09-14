SELECT id, user_id, total_cents, created_at
FROM orders
WHERE status = 'pending'
ORDER BY created_at
LIMIT 100
