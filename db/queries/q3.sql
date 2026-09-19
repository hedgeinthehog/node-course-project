SELECT id, email, name
FROM users
WHERE lower(email) = lower('User12345@Example.com')
