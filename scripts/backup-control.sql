SELECT 'tables|' || count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT format('SELECT %L || count(*) FROM public.%I', 'rows|' || tablename || '|', tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
SELECT to_regclass('public.orders') IS NOT NULL AS has_orders \gset
\if :has_orders
SELECT 'orders|count,sum(total_cents)|' || count(*) || '|' || coalesce(sum(total_cents), 0) FROM public.orders;
\endif
