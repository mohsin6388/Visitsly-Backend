# Production update — Nov 2026

## Deploy checklist
1. `npm install` (new deps: `compression`, `@socket.io/redis-adapter`, `redis`). Node 18.17+.
2. MongoDB **5.0+** (Atlas default is fine) — the inbox uses `$lookup` with a sub-pipeline.
3. Copy `.env.example` → `.env` and fill it. New optional vars: `REDIS_URL`, `AI_HISTORY_LIMIT`, `AI_STORE_PROMPTS`, `PRICE_BOOK_JSON`, `TAX_RATE_<CUR>`.
4. **Cloudinary** (recommended): WhatsApp photos / PDFs are copied there so they stay viewable after Meta's 30-day expiry.
5. **Razorpay webhook** (`/api/webhooks/razorpay`) — enable events: `subscription.*`, `payment.captured`, `payment.failed`, `order.paid`.
   For AED/USD/GBP pricing turn on *International payments* in Razorpay; until then checkout automatically falls back to INR.
6. **Bolna** (AI calling, per company): each company pastes its own API key + agent ID on *WhatsApp AI → Visit confirmation*,
   and sets the webhook URL shown there in its Bolna agent. Add extraction keys `visit_confirmed`, `visit_date`, `visit_time`.
7. Scaling to many instances: set `REDIS_URL` (realtime across instances). Background jobs use a MongoDB lock
   (`scheduler_locks` collection) so only one instance runs each scheduler.
8. One-time data fixes run automatically at boot (`app_migrations` collection): follow-ups default to *auto*,
   inbox preview backfill, Razorpay plan index per currency.

## What changed (high level)
- **WhatsApp connect**: plain-language Meta error messages, input cleaning, number↔WABA check, runtime token/number
  problems auto-flagged with a "Reconnect" notice, one-click *Connection check* + *Fix webhook*.
- **Upload Data** (was "All leads"): after upload → "Schedule karein?" → WhatsApp/Email campaign with date, time, number
  of days. Campaigns show their start date and status (Scheduled / Running / Paused / Completed).
- **AI inbox**: filter menu (Unread, Reply baaki, Direct WhatsApp, Hot, Warm, Site visit, Closed, AI band, Lost) with counts,
  infinite scroll, skeleton loaders, error popups, live AI replies (no refresh), photos/videos/PDF/voice notes in & out
  with download, one-click brochure/photos send, 1-line summary + requirement, score bar, follow-up date relative to today.
- **AI memory & language**: chosen language is locked and persisted; long-term memory + returning-customer handling;
  AI knows today's date; follow-up dates can no longer be in the past.
- **Visit confirmation**: call-first flow (AI call → not answered → WhatsApp "humne call kiya tha…"), retries, calling hours,
  stats (calls placed / answered / not answered / WhatsApp fallbacks / confirmed by call vs WhatsApp), test call.
- **Owner alerts**: hot lead, visit booked, visit confirmed/declined → owner's WhatsApp instantly (template / email fallback).
- **Budget**: Reports → *Kharcha & budget*: WhatsApp (Meta) + AI calling spend, thresholds (50/80/100%), WhatsApp report,
  optional auto-pause of campaigns at 100%.
- **Follow-ups**: automatic by default; "not interested" customers get polite re-follow-ups (7 & 30 days by default);
  STOP/unsubscribe is always honoured (campaigns, follow-ups and AI skip them).
- **Billing**: plans first, currency by signup country, add-ons purchasable in-app (Razorpay order), success/failure popups.
- **Team**: add many teammates at once (or paste from Excel) with owner-chosen passwords; set password per member.
- **Overview**: lead-source performance (Facebook/Instagram, Google, 99acres, MagicBricks, Housing, website, WhatsApp…).
- **Lead sources**: "Test lead" button runs a real enquiry through the pipeline.
- Settings: AI reply delay removed; Setup checklist removed (new users land on *Connect WhatsApp*).
