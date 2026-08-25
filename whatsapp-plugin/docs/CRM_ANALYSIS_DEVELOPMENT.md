# CRM Conversation Intelligence

## Delivered

- Meta inbound events are persisted before processing and recoverable after restart.
- Text, image, video, audio, document, sticker, location, contact, interactive, button, reaction, and order events are retained as typed communication records. Media IDs remain in the signed Meta payload archive; downloading media is a separate retention-controlled step.
- `conversation_analyses` stores a versioned, evidence-backed summary, traits, buying intent, risk level, and next action.
- `conversation_followups` stores deduplicated follow-up items with evidence message IDs, due time, priority, and lifecycle status.
- Rule extraction remains the zero-cost baseline. An operator can select a tested OpenAI-compatible Provider for periodic structured analysis; model output is schema-validated, evidence IDs are restricted to stored messages, and failures fall back to rule results with a visible warning.
- Every analysis records `engine`, `model`, and `promptVersion`. Human confirmation raises confidence; rejection removes the trait and synchronously dismisses its pending follow-up. Restoring feedback reactivates the prior follow-up without reopening completed work.
- The communication workspace exposes analysis and follow-up actions. In an embedded GoodJob CRM deployment, a follow-up can create a personal GoodJob Todo through `/api/todos`; the local communication status is then marked completed.
- Contact import first reads the parent CRM `/api/customers` endpoint when embedded, while standalone desktop mode falls back to the communication CRM contact table.

## API

- `GET /api/v1/conversations/:id/intelligence`
- `POST /api/v1/conversations/:id/intelligence/analyze`
- `PATCH /api/v1/followups/:id` with `{ "status": "pending|completed|dismissed" }`
- `PUT /api/v1/conversations/:id/intelligence/feedback`
- `DELETE /api/v1/conversations/:id/intelligence/feedback/:traitKey`
- `GET /api/v1/commercial-readiness`

Analysis is intentionally evidence-first: every extracted trait and follow-up carries message IDs. Users can create a Todo immediately from the customer drawer; the daily automation also writes pending items to GoodJob CRM and sends internal notifications with per-day idempotency. Delivery errors fail the run, release the delivery claim for retry, and remain visible in run history.

## Production Boundary

The deployment compose file sets `WHATSAPP_OFFICIAL_ONLY=true`. Baileys remains available only when explicitly enabled in non-production development/test runtimes. Real Meta credentials, a public HTTPS callback, and Meta-approved templates are required for production send/receive acceptance.

## Release Self-Test

Run from this directory before submitting the Meta App or deploying a release:

```bash
npm run test:release
```

The command performs type checking, production web/server builds, database migration lifecycle checks, official-channel boundary checks, Meta Graph mock validation, signed Webhook Inbox idempotency/recovery, non-text message retention, conversation intelligence extraction, follow-up lifecycle, and CRM contact import checks. Tests requiring a live MySQL/PostgreSQL service remain explicitly skipped until those services are supplied.
