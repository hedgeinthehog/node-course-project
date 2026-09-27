CREATE ROLE marketplace NOLOGIN;
CREATE ROLE marketplace_a LOGIN PASSWORD 'marketplace_dev' IN ROLE marketplace;
CREATE ROLE marketplace_b LOGIN PASSWORD 'marketplace_dev' IN ROLE marketplace;
ALTER DATABASE marketplace OWNER TO marketplace;
GRANT ALL ON SCHEMA public TO marketplace;
ALTER ROLE marketplace_a SET role = 'marketplace';
ALTER ROLE marketplace_b SET role = 'marketplace';
