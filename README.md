# Marketplace API

ДЗ №1 (hw-09):

**Обраний варіант contract-частини: А (consumer-driven Pact).** Консюмер `marketplace-web`
у `test/consumer.pact.test.mjs` декларує очікування до `GET /orders/{id}`, «код фронта»
(`test/orders-client.mjs`) ганяється проти mock-провайдера, контракт пишеться у
`pacts/marketplace-web-marketplace-api.json`.

Сам сервер — NestJS з in-memory даними; додатково на кордоні стоїть `express-openapi-validator`
(запити й відповіді звіряються зі спекою, помилки віддаються як `application/problem+json`).

## Вимоги

Node.js ≥ 22.12.0.

## Запуск

```bash
npm install
npm start
```

Сервер слухає `http://localhost:3000`.

## Що є в контракті

| Ресурс | Операції |
| --- | --- |
| `/products` | `GET /products` (cursor-пагінація), `POST /products` (Idempotency-Key), `GET /products/{id}` |
| `/orders` | `GET /orders` (cursor-пагінація), `POST /orders` (Idempotency-Key), `GET /orders/{id}` |

- **Cursor-пагінація**: `?limit=&cursor=`, відповідь `{ items, next_cursor }`, `next_cursor: null` — сторінок більше немає. Курсор — непрозорий токен.
- **Idempotency-Key**: обовʼязковий header на обох POST. Той самий ключ + те саме тіло → та сама відповідь `201` + `Idempotency-Replay: true`; той самий ключ + інше тіло → `422`.
- **problem+json**: кожна помилка — `application/problem+json` зі схемою `Problem` (`type`, `title`, `status`, `detail`, `instance`).
- Гроші — цілі копійки (`price_cents`, `total_cents`).

## Перевірки

Contract-тест консюмера (створює `pacts/*.json`):

```bash
npm run test:pact
```

```bash
ls pacts/*.json
```
