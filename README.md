# Evidence Trust

Evidence-first transaction protection for social commerce: a verifiable trail from agreement to resolution.

- Architecture, ERD, API, security, deployment: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Backend: [apps/api](apps/api) (Fastify + PostgreSQL, TypeScript). One image runs the API, the worker, and migrations.

## Develop

```bash
cp .env.example .env        # fill in values; never commit .env
npm ci
npm run migrate             # needs DATABASE_URL pointing at Postgres 16+
npm run dev -w @evidence-trust/api          # API
npm run dev:worker -w @evidence-trust/api   # background worker
npm test                    # runs against real Postgres semantics (PGlite), no Docker needed
```

## Provider status

Providers without credentials are not faked: payment/evidence endpoints return `503 provider_not_configured`,
emails are marked failed and retried, and nothing is reported as paid/sent/verified without provider confirmation.

| Capability | Adapter | Status |
|---|---|---|
| Payments + webhooks | Stripe | implemented, needs `STRIPE_*` (untested against live Stripe) |
| Evidence storage | S3 | implemented, needs `S3_BUCKET` + AWS credentials (untested against live S3) |
| Email | Resend | implemented, needs `RESEND_API_KEY`, `EMAIL_FROM` |
| SMS | Twilio | adapter only, no flow sends SMS yet |
| Seller KYC | none | interface only; `verified` can never be set without a provider |

No web UI exists yet; see the implementation plan in the architecture doc.
