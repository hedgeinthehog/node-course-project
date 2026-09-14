CREATE INDEX idx_orders_user_id_created_at ON orders (user_id, created_at DESC);
CREATE INDEX idx_orders_pending_created_at ON orders (created_at) WHERE status = 'pending';
CREATE INDEX idx_users_lower_email ON users (lower(email));
CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);
