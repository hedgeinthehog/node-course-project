CREATE ROLE marketplace NOLOGIN;
CREATE ROLE marketplace_a LOGIN PASSWORD 'marketplace_dev' IN ROLE marketplace;
CREATE ROLE marketplace_b LOGIN PASSWORD 'marketplace_dev' IN ROLE marketplace;
ALTER DATABASE marketplace OWNER TO marketplace;
GRANT ALL ON SCHEMA public TO marketplace;
ALTER ROLE marketplace_a SET role = 'marketplace';
ALTER ROLE marketplace_b SET role = 'marketplace';

CREATE ROLE pgbouncer LOGIN PASSWORD 'pgbouncer_dev';
CREATE SCHEMA pgbouncer AUTHORIZATION postgres;
CREATE FUNCTION pgbouncer.get_auth(p_usename text)
  RETURNS TABLE (usename name, passwd text)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT usename, passwd FROM pg_shadow WHERE usename = p_usename $$;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer;
