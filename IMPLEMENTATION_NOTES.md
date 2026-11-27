# Update (21 Oct 2026) — Meta WhatsApp charges on the dashboard

- `GET /api/analytics/meta-billing?range=this_month|last_month|30d|7d` reads the WhatsApp Business Account's `pricing_analytics` (Graph API, COST + VOLUME, by pricing category / pricing type / phone, daily) and returns totals, charged vs free messages, category split, daily series, the monthly free service-message allowance (1,000 per number) and a per-campaign estimate (WhatsApp messages this CRM sent × Meta's average cost for that template category). Cached 30 minutes per range.
- Needs `META_WHATSAPP_ACCESS_TOKEN` (with `whatsapp_business_management`) and `META_WHATSAPP_BUSINESS_ACCOUNT_ID`. Meta labels these figures approximate; GST and the final amount are on Meta's invoice. If the account is billed on a Solution Partner's credit line, Meta returns message counts but no cost — the dashboard then shows "—" for money.

---

# Update (20 Oct 2026) — site-wise brochures

- New `PropertySite` model: one record per site / project (matched to `Property.projectName`, case-insensitive) with its own `brochures[]` (url, name, label, uploadedAt) and `images[]`.
- `GET /api/sites` (sites + unit / available counts from the Properties sheet, including projects that have no site record yet), `POST /api/sites/brochure` (multipart: `siteName`, optional `label`, `city`, `location`, `brochure` PDF, `images[]`), `PATCH /api/sites/:id`, `DELETE /api/sites/:id/brochures/:brochureId`, `DELETE /api/sites/:id/images`.
- "Add Brochure" (AI extraction) now also saves the brochure and photos on that project's site.
- WhatsApp AI: when a customer asks for a brochure, the newest brochure of that project's site is sent (falls back to the brochure saved on the unit row). If the site has none, the AI can offer another site's brochure, as before.
- Bulk-send history now stores header / body / footer / buttons of the template (`whatsappTemplateHeader`, `whatsappTemplateFooter`, `whatsappTemplateButtons` on launch).

---

# PropAI CRM — flow update (19 Oct 2026)

Design is unchanged; behaviour now follows the new PropAI flow.

## Lead rules (one place: `src/config/leadRules.js`)
- A contact becomes a **lead** after a WhatsApp or email reply **and** an AI conversation score above **30**.
- **Hot lead** = score above **60**. **Visit lead** = any site visit booked (AI on WhatsApp, or manual).
- `Lead.status` temperature now follows the score (cold ≤ 30, warm 31–60, hot > 60); the model's own label is ignored. Manual `closed` / `lost` / `site_visit` are never overwritten.
- Email replies are now scored too (Brevo inbound webhook → `analyzeLeadAsync`). The score reads WhatsApp + email history together.
- WhatsApp replies are scored even when the AI does not answer (manual takeover, AI paused, no Gemini key).
- With no Gemini key, a simple keyword scorer runs so the 30/60 rules still work. If a Gemini key exists but the call fails, the previous score is kept.

## API changes
- `Lead`: new `address`, `jobTitle` fields (form, import aliases such as "Mobile / WhatsApp", "Job title", export).
- `GET /api/leads?qualifiedOnly=1&stage=all|hot|visit&replyChannel=whatsapp|email` → rows include `leadType` (visit/hot/lead/contact); `summary.qualified` has `{ all, hot, visit }` counts. `?ids=a,b` filters by id. `summary.repliedContacts` added.
- `POST /api/leads/import/confirm` also returns `existingLeadIds` (contacts already in Upload Data) so a sheet can become an audience.
- New **Audiences**: `GET/POST /api/audiences`, `GET/PATCH/DELETE /api/audiences/:id`, `GET /api/audiences/:id/leads?channel=whatsapp|email&excludeSent=1`.
- `POST /api/campaigns/launch` accepts optional `audienceId` (stored on the campaign; audience `lastUsedAt` updated).
- `Meeting`: new `source` (`whatsapp_ai` | `manual`) and `conversationId`. AI-booked visits are tagged `whatsapp_ai`. `GET /api/meetings` accepts `source` and `when=today|upcoming|past`; rows carry `conversationId` + `chatSummary`; summary adds `today`, `upcoming`, `chatBooked`. Visits created before this update have no `source`.
- `GET /api/conversations?leadId=` (open a lead's chat); `GET /api/conversations/:id` returns `insights { latestScore, followUp, meetings }` for the summary panel.
- `Property`: new `availability` (`available` | `booked` | `sold`), `floor`, `possession`. Only available units are suggested by the AI. Import reads Status / Floor / Possession columns.
- WhatsApp templates list now includes Meta's `rejectedReason`.

## Verification
All backend modules load (`node -e require(...)`), and unit checks for lead rules, sheet header mapping and the fallback scorer pass. Not run against a live MongoDB / Meta / Brevo in this environment — test with an internal contact first (upload → bulk send → reply → check Qualified Leads, Site Visits, Follow Ups).

---

# PropAI CRM — implementation and production setup notes

## Changes in this delivery

- Reworked the login layout with an emerald, ivory and gold property-brand theme and included the property background asset in the frontend's `public/images` folder.
- Simplified the CRM header/sidebar branding and tightened copy in the Upload Data and Qualified Leads screens.
- Added import modes for WhatsApp-only, Email-only and both channels. Import still only saves contacts; it does not send messages.
- Removed manual age, occupation and lead-budget inputs. Lead temperature and score are surfaced in the contact list and the AI qualification workflow.
- Filtered WhatsApp conversations to actual inbound customer messages or successfully sent outbound messages. Empty imported-contact conversation shells are hidden. First template sends are logged with the actual template body when its content is known.
- Removed campaign start-time/daily schedule controls; campaigns created from the current UI are queued to start immediately, still with the worker's message pacing and provider limits. The launch form currently caps one campaign at 5,000 contacts.
- Added image URL storage for Email templates and Cloudinary upload API support for template/property images. The upload endpoint accepts a single image up to 25 MB; property uploads accept images up to 25 MB each in the new upload flow. WhatsApp's sample image for an IMAGE-header Meta template is capped at 5 MB before submission.
- Added WhatsApp template deletion through Meta's Graph API, with the matching local Cloudinary asset record cleared.
- Added configurable hot-lead alerts in Settings. Alerts are disabled until a destination phone number is saved; Hot only is the default. Optionally enable Hot or Warm.
- Raised default access token lifetime to 8 hours and refresh token lifetime to 90 days. Existing `.env` values override these defaults.

## Required environment setup

Copy `.env.example` to `.env` in the backend, then set real credentials. Never commit `.env` to source control.

- **MongoDB / auth:** set `MONGO_URI`, strong unique `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `ENCRYPTION_KEY`. Existing users may remain logged in until their old token expires; new sessions use the configured expiry.
- **Cloudinary uploads:** configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. The backend returns Cloudinary HTTPS URLs which are saved into property/template records.
- **Official WhatsApp Cloud API:** configure the `META_WHATSAPP_*` values already documented in `.env.example`, using a long-lived System User token and the correct Phone Number ID and WABA ID. Image-header template submission also needs `META_APP_ID` and Meta app upload permissions.
- **Lead alerts:** save the recipient number in **Settings → Alert your lead on your number** (international digits, e.g. `919876543210`). The default is Hot only. If Meta rejects free-text because the recipient's 24-hour service window is closed, create and approve an alert template in WhatsApp Manager and set `META_WHATSAPP_LEAD_ALERT_TEMPLATE_NAME` plus its language in `.env`. Its BODY should contain five text placeholders matching: lead name, phone, email, score, summary. A Meta-approved template and valid consent/opt-in are still required where applicable.
- **Email:** configure `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, and the relevant inbound webhook settings for sending/replies.
- **Frontend:** set `VITE_API_BASE_URL` to the deployed backend's `/api/` origin before building.
- **Cross-origin HTTPS deployment:** if frontend and backend are on different HTTPS origins, set `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`; set `CLIENT_URL` to the actual frontend origin. If you use a cookie domain, set `COOKIE_DOMAIN` only to a domain that should receive it. Confirm CORS credentials are enabled for that origin.

## Deployment checklist

1. Install frontend/backend dependencies from their lockfiles in your deployment environment.
2. Set all production secrets as environment variables; do not ship a local `.env`.
3. Confirm Cloudinary, Meta, Brevo, MongoDB and frontend API origin are valid.
4. Start the API and confirm `GET /api/health` returns success.
5. Test with an internal opt-in test contact first: import only, send one approved WhatsApp template, verify inbound webhook/replies, send one email, upload a property image, then test a hot-lead alert.
6. Check Meta template approval status, WhatsApp opt-in/quality policy, email consent/unsubscribe process and local privacy requirements before any bulk campaign.

## Verification limits for this source bundle

Backend JavaScript syntax checks passed during preparation. A frontend production build could not be run in this environment because frontend npm dependencies could not be resolved/downloaded, and no live MongoDB, Cloudinary, Meta or Brevo credentials were available for provider integration tests. Run `npm ci && npm run build` for the frontend and install/test the backend in the target deployment environment before treating it as production-verified.

## 22 Oct 2026 — Multi-tenant SaaS

See **SAAS_SETUP.md** for the full design and the go-live checklist. In short:

- New models: `Organization` (company, plan, subscription, usage, encrypted WhatsApp credentials), `Invoice`, `RazorpayPlan`. `User` gains `orgId`, `orgRole` (owner/manager/agent) and `isSuperAdmin`. `Settings`, `AuditLog` and `Conversation` gain per-company fields.
- Tenant context (`src/context/tenantContext.js`) + auto-scoping Mongoose plugin (`tenantScopePlugin.js`). `env.metaWhatsapp` returns the current company's number and token.
- Meta webhooks are routed by `phone_number_id`. The bulk worker runs companies in parallel, and pauses and gaps apply per company. The daily report and startup catch-up run per company. Socket rooms are shared by the whole company team.
- Plans and limits in `src/config/plans.js`, enforced on contacts (manual add + import), team size, AI conversations per month and campaigns per month. Lapsed subscriptions are read-only (HTTP 402).
- Razorpay Subscriptions checkout, verification, webhook and offline payments. WhatsApp Embedded Signup and manual connect. Team management. Platform super-admin API.
- Security fixes found while doing this: tenant `admin` role and `?ownerId=` could read another workspace; the AI property matcher read every company's inventory; inbound WhatsApp matched leads across owners. All three are now scoped.
- Scripts: `npm run saas:migrate` (moves the existing single client in as company #1) and `npm run seed:superadmin`.
- Tested: 50 end-to-end API checks (signup, isolation, roles, limits, trial expiry, Razorpay verify and webhooks, WhatsApp routing, platform admin), 8 tenant-scoping unit checks, a migration dry run, and 19 browser checks of the new screens.

## 22 Oct 2026 (later) — Separate admin panel + full customer feature set

- Admin panel is now a separate app (`propai-admin-panel`) with its own auth: `/api/admin-auth/*`, admin JWT secrets, and an `adminRefreshToken` cookie scoped to `/api/admin-auth`. `/api/platform/*` accepts only admin tokens. Customer login refuses PropAI admins. Support access uses a 60-minute "support session" token opened from the admin panel; the old `X-Org-Id` header was removed.
- CORS allows the customer app, the admin app, `CORS_ORIGINS`, and white-label domains (reloaded on change). Public `/api/inbound/*` reflects any origin.
- New: lead capture (`leadCapture.js`, `portalParsers.js`, `metaLeadAds.js`, `inboundController.js`), round-robin routing (`routing.js`), reports and weekly report (`reportsService.js`), cost sheets with a pdfkit PDF (`Quote`, `quoteService.js`), channel partner portal (`ChannelPartner`, `cpController.js`), AI calling via Plivo + ElevenLabs + Gemini/Groq (`CallLog`, `voiceService.js`, `voiceAgent.js`, `plivoClient.js`, `tts.js`), extra WhatsApp numbers (`Organization.extraNumbers` and `tenantContext.runWithNumber`), add-ons and white-label (`Organization.addons/branding`), and customer requests (`PlatformRequest`).
- Tests: 105 end-to-end API checks and 14 browser checks (customer app, public form, CP portal, admin panel, support session, mobile width).


---

## Nov 2026 update — shorter language question, brochure review, billing guard, coupons & offers

### Deployment (uploads fail with "413 Request Entity Too Large")
nginx in front of the API domain defaults to `client_max_body_size 1m`, so brochure/image uploads are
rejected **before** they reach Node (the app's multer limit is already 30 MB per file). In the server block of
the API domain (e.g. `api.visitsly.com`) add:

```nginx
client_max_body_size 60m;     # PDF 10 MB + 10 images x 5 MB
proxy_read_timeout 180s;      # upload + Cloudinary + Gemini extraction
```

then `sudo nginx -t && sudo systemctl reload nginx`. Multer limits are unchanged.

### New / changed endpoints
| Method + path | Purpose |
|---|---|
| `POST /api/properties/brochure/extract` | Upload brochure + images, extract + validate with Gemini, return `{ extracted, brochure, images, warnings }`. **Nothing is saved.** Uploaded files are removed again if extraction fails. |
| `POST /api/properties/brochure/confirm` | Body = reviewed fields + `brochure` + `images` → validates (zod + normaliser) and creates the Property + site brochure. |
| `POST /api/properties/brochure` | Unchanged (old clients). |
| `GET/POST /api/billing/coupon/validate` | `{ code, plan, cycle }` → `{ valid, coupon, quote }`. Creates/counts nothing. |
| `GET /api/billing/quote?plan&cycle&coupon=` | Quote now includes offer + coupon (extra fields only). |
| `POST /api/billing/checkout` | Accepts optional `coupon`; coupon and offer are re-validated server-side. New 400 code `PLAN_ALREADY_ACTIVE`. |
| `POST /api/billing/checkout/cancel` | `{ orderId \| subscriptionId }` — popup dismissed → clears pendingPlan. |
| `GET/POST/PATCH /api/platform/coupons`, `POST /api/platform/coupons/:id/disable`, `GET /api/platform/coupons/:id/redemptions` | Coupon admin (admin auth, audit-logged). |
| `GET/PUT/DELETE /api/platform/plan-offers` | Set / list / clear strike-through offers per plan + cycle + currency (audit-logged). |
| `GET /api/public/plans`, `GET /api/billing` | Plans may carry `offer: { monthly?, annual? }` (additive). `/api/billing` also returns `activePlanLocked`. |

Socket event `conversation:newMessage` now also carries `leadName` (inbound messages).

### Billing decisions
* **Maths:** list price → offer price (or the company's custom `priceOverride`, which wins) → minus coupon → + GST/tax
  (`pricing.withTax`). Razorpay amount, quote, and invoice (`subtotal`, `taxAmount`, `amount`, `pricing.*`) are
  computed from the same quote.
* **Coupon `appliesTo`:** `first` (default) — a Razorpay subscription cannot discount only its first charge cleanly,
  so the first period is paid as a **one-time order** (existing order mode); the customer renews from the Billing
  page afterwards. `all` — the subscription is created on a Razorpay plan priced at the discounted amount.
* **Offers in subscription mode:** the offer price is locked into the Razorpay plan for the life of that subscription.
* **Redemptions** are counted only after a successful payment, once per payment/order id.
* **Plan safety:** a plan changes only after a verified payment. `handleWebhook` uses `sub.notes.plan/cycle`;
  `pendingPlan` is used only when the webhook's subscription id equals `razorpay.pendingSubscriptionId`; unknown
  subscriptions are ignored. `activate()` no longer falls back to `pendingPlan`.
* **No plan switching while a plan is active:** `PLAN_ALREADY_ACTIVE` when status is `active`, the period is live and
  the requested plan/cycle differs (or an auto-renewing subscription already exists). Same-plan renewal in order mode
  still works. Platform admins change plans via `/api/platform/orgs/:id`.
* New collections: `coupons`, `couponredemptions`, `planoffers`. New optional fields: `Invoice.pricing`,
  `Organization.pendingCheckout`. No new env variables.

### Tests
`npm run test:billing` (guard, coupon/offer maths, redemption, webhook safety) and `npm run test:brochure`
(extraction validation) were added; existing suites are unchanged except one assertion in `test/language.smoke.js`.

# Part A + Part B (team permissions, Email via Brevo) — Nov 2026

See EMAIL_SETUP.md for Part B. Route → permission table:

info: [gemini] Model chain: gemini-3.5-flash -> gemini-3.5-flash-lite -> gemini-3.1-flash-lite -> gemini-2.5-flash (2 attempts each) {"timestamp":"2026-11-27T07:08:51.623Z"}
| Method | Route | Agent access |
|---|---|---|
| POST | `/api/auth/signup` | public (no login; secured by token/signature) |
| POST | `/api/auth/verify-email` | public (no login; secured by token/signature) |
| POST | `/api/auth/resend-verification` | public (no login; secured by token/signature) |
| POST | `/api/auth/change-password` | any logged-in agent (data scoped to their assigned leads) |
| POST | `/api/auth/login` | public (no login; secured by token/signature) |
| POST | `/api/auth/refresh` | public (no login; secured by token/signature) |
| POST | `/api/auth/logout` | public (no login; secured by token/signature) |
| POST | `/api/auth/forgot-password` | public (no login; secured by token/signature) |
| POST | `/api/auth/reset-password` | public (no login; secured by token/signature) |
| GET | `/api/auth/me` | any logged-in agent (data scoped to their assigned leads) |
| PATCH | `/api/auth/profile` | any logged-in agent (data scoped to their assigned leads) |
| POST | `/api/uploads/image` | any logged-in agent (data scoped to their assigned leads) |
| GET | `/api/email/status` | owner only |
| POST | `/api/email/sender` | owner only |
| POST | `/api/email/sender/verify` | owner only |
| POST | `/api/email/sender/resend` | owner only |
| POST | `/api/email/sender/check-dns` | owner only |
| DELETE | `/api/email/sender` | owner only |
| GET | `/api/email/wallet` | owner only |
| GET | `/api/email/estimate` | owner only |
| GET | `/api/email/templates` | owner only |
| POST | `/api/email/templates` | owner only |
| PUT | `/api/email/templates/:id` | owner only |
| DELETE | `/api/email/templates/:id` | owner only |
| GET | `/api/email/details` | owner only |
| POST | `/api/webhooks/brevo` | public (no login; secured by token/signature) |
| GET | `/api/webhooks/email-unsubscribe/:token` | public (no login; secured by token/signature) |
| POST | `/api/webhooks/email-unsubscribe/:token` | public (no login; secured by token/signature) |
| POST | `/api/webhooks/razorpay` | public (no login; secured by token/signature) |
| GET | `/api/webhooks/meta-leads` | public (no login; secured by token/signature) |
| POST | `/api/webhooks/meta-leads` | public (no login; secured by token/signature) |
| POST | `/api/webhooks/voice/plivo/:event/:callId` | public (no login; secured by token/signature) |
| GET | `/api/webhooks/voice/plivo/:event/:callId` | public (no login; secured by token/signature) |
| GET | `/api/webhooks/voice/audio/:file` | public (no login; secured by token/signature) |
| POST | `/api/leads/import/preview` | needs leadImport |
| POST | `/api/leads/import/parse-text` | needs leadImport |
| POST | `/api/leads/import/confirm` | needs leadImport |
| POST | `/api/leads/start-conversations` | needs chatReply |
| GET | `/api/leads/export` | owner only |
| GET | `/api/leads/import-files` | any of leads + whatsappLeads |
| POST | `/api/leads/bulk-delete` | needs leadDelete |
| GET | `/api/leads` | any of leads + whatsappLeads + inbox + siteVisits + followUps + dashboard |
| POST | `/api/leads` | needs leadCreate |
| GET | `/api/leads/:id` | any of leads + whatsappLeads + inbox + siteVisits + followUps + dashboard |
| PATCH | `/api/leads/:id` | needs leadEdit |
| DELETE | `/api/leads/:id` | needs leadDelete |
| POST | `/api/leads/:id/tags` | needs leadEdit |
| GET | `/api/audiences` | owner only |
| POST | `/api/audiences` | owner only |
| GET | `/api/audiences/:id/leads` | owner only |
| GET | `/api/audiences/:id` | owner only |
| PATCH | `/api/audiences/:id` | owner only |
| DELETE | `/api/audiences/:id` | owner only |
| POST | `/api/campaigns/launch` | owner only |
| GET | `/api/campaigns` | owner only |
| GET | `/api/campaigns/:id` | owner only |
| POST | `/api/campaigns/:id/pause` | owner only |
| POST | `/api/campaigns/:id/resume` | owner only |
| POST | `/api/campaigns/:id/cancel` | owner only |
| DELETE | `/api/campaigns/:id` | owner only |
| POST | `/api/campaigns/:id/retry-failed` | owner only |
| GET | `/api/outreach/summary` | owner only |
| GET | `/api/outreach/jobs` | owner only |
| POST | `/api/properties/brochure` | owner only |
| POST | `/api/properties/brochure/extract` | owner only |
| POST | `/api/properties/brochure/confirm` | owner only |
| POST | `/api/properties/import/preview` | owner only |
| POST | `/api/properties/import/confirm` | owner only |
| GET | `/api/properties/export` | owner only |
| POST | `/api/properties/bulk-delete` | owner only |
| POST | `/api/properties` | owner only |
| GET | `/api/properties` | any of properties + chatReply |
| GET | `/api/properties/:id` | any of properties + chatReply |
| PATCH | `/api/properties/:id` | owner only |
| DELETE | `/api/properties/:id` | owner only |
| GET | `/api/sites` | any of properties + chatReply |
| POST | `/api/sites/brochure` | owner only |
| PATCH | `/api/sites/:id` | owner only |
| DELETE | `/api/sites/:id/brochures/:brochureId` | owner only |
| DELETE | `/api/sites/:id/images` | owner only |
| GET | `/api/whatsapp/webhook` | public (no login; secured by token/signature) |
| POST | `/api/whatsapp/webhook` | public (no login; secured by token/signature) |
| POST | `/api/whatsapp/webhook/forward` | public (no login; secured by token/signature) |
| GET | `/api/whatsapp/status` | any logged-in agent (data scoped to their assigned leads) |
| GET | `/api/whatsapp/templates` | any logged-in agent (data scoped to their assigned leads) |
| GET | `/api/whatsapp/templates/all` | any logged-in agent (data scoped to their assigned leads) |
| POST | `/api/whatsapp/templates` | owner only |
| DELETE | `/api/whatsapp/templates/:name` | owner only |
| GET | `/api/whatsapp/diagnostics` | owner only |
| POST | `/api/whatsapp/repair-subscription` | owner only |
| POST | `/api/whatsapp/send-test` | owner only |
| POST | `/api/whatsapp/send-test-template` | owner only |
| POST | `/api/whatsapp/disconnect` | owner only |
| POST | `/api/whatsapp/reconnect` | owner only |
| GET | `/api/conversations` | any of inbox + whatsappLeads |
| GET | `/api/conversations/counts` | any of inbox + whatsappLeads |
| GET | `/api/conversations/:id` | any of inbox + whatsappLeads |
| GET | `/api/conversations/:id/media/:messageId` | any of inbox + whatsappLeads |
| POST | `/api/conversations/:id/messages` | needs chatReply |
| POST | `/api/conversations/:id/media` | needs chatReply |
| POST | `/api/conversations/:id/property-media` | needs chatReply |
| PATCH | `/api/conversations/:id/language` | needs chatReply |
| POST | `/api/conversations/:id/takeover` | needs chatReply |
| POST | `/api/conversations/:id/resume-ai` | needs chatReply |
| POST | `/api/conversations/:id/read` | any of inbox + whatsappLeads |
| POST | `/api/conversations/:id/close` | needs chatReply |
| POST | `/api/conversations/:id/reopen` | needs chatReply |
| GET | `/api/meetings` | any of siteVisits + dashboard + inbox + leads + whatsappLeads |
| GET | `/api/meetings/confirmation-stats` | owner only |
| GET | `/api/meetings/confirmation-calls` | owner only |
| POST | `/api/meetings` | needs siteVisits |
| PATCH | `/api/meetings/:id` | needs siteVisits |
| POST | `/api/meetings/:id/send-confirmation` | needs siteVisits + chatReply |
| POST | `/api/meetings/:id/call-confirmation` | owner only |
| POST | `/api/meetings/:id/mark-confirmation` | needs siteVisits |
| DELETE | `/api/meetings/:id` | needs siteVisits |
| GET | `/api/followups` | any of followUps + dashboard |
| PATCH | `/api/followups/:id` | needs followUps |
| POST | `/api/followups/:id/send` | needs followUps + chatReply |
| POST | `/api/followups/lead/:id` | needs followUps |
| DELETE | `/api/followups/:id` | needs followUps |
| GET | `/api/settings` | owner only (writes) |
| PATCH | `/api/settings` | owner only (writes) |
| POST | `/api/settings/ai/pause` | owner only (writes) |
| POST | `/api/settings/ai/resume` | owner only (writes) |
| POST | `/api/settings/daily-report/send-now` | owner only (writes) |
| POST | `/api/settings/test-alert` | owner only (writes) |
| POST | `/api/settings/assistant/improve` | owner only (writes) |
| GET | `/api/analytics/dashboard` | needs dashboard |
| GET | `/api/analytics/timeseries` | needs dashboard |
| GET | `/api/analytics/funnel` | needs dashboard |
| GET | `/api/analytics/lead-sources` | owner only |
| GET | `/api/analytics/source-performance` | owner only |
| GET | `/api/analytics/meta-billing` | owner only |
| GET | `/api/analytics/property-performance` | owner only |
| GET | `/api/notifications` | any logged-in agent (data scoped to their assigned leads) |
| PATCH | `/api/notifications/read-all` | any logged-in agent (data scoped to their assigned leads) |
| PATCH | `/api/notifications/:id/read` | any logged-in agent (data scoped to their assigned leads) |
| DELETE | `/api/notifications/:id` | any logged-in agent (data scoped to their assigned leads) |
| GET | `/api/audit-logs` | any logged-in agent (data scoped to their assigned leads) |
| GET | `/api/org` | any logged-in agent (data scoped to their assigned leads) |
| PATCH | `/api/org` | owner only |
| PATCH | `/api/org/onboarding` | owner only |
| PATCH | `/api/org/profile` | owner only |
| PATCH | `/api/org/profile/draft` | owner only |
| GET | `/api/org/whatsapp` | owner only |
| GET | `/api/org/whatsapp/health` | owner only |
| POST | `/api/org/whatsapp/fix-webhook` | owner only |
| POST | `/api/org/whatsapp/embedded-signup` | owner only |
| POST | `/api/org/whatsapp/embedded-signup/prepare` | owner only |
| POST | `/api/org/whatsapp/embedded-signup/complete` | owner only |
| POST | `/api/org/whatsapp/manual` | owner only |
| POST | `/api/org/whatsapp/disconnect` | owner only |
| POST | `/api/org/whatsapp/test-message` | owner only |
| POST | `/api/org/whatsapp/coexistence/sync` | owner only |
| GET | `/api/org/whatsapp/opening-template/options` | owner only |
| PATCH | `/api/org/whatsapp/opening-template` | owner only |
| POST | `/api/org/whatsapp/numbers` | owner only |
| DELETE | `/api/org/whatsapp/numbers/:phoneNumberId` | owner only |
| GET | `/api/org/lead-sources` | owner only |
| PATCH | `/api/org/lead-sources` | owner only |
| POST | `/api/org/lead-sources/test` | owner only |
| POST | `/api/org/lead-sources/meta/pages` | owner only |
| POST | `/api/org/lead-sources/meta/connect` | owner only |
| POST | `/api/org/lead-sources/meta/disconnect` | owner only |
| GET | `/api/org/routing` | owner only |
| PATCH | `/api/org/routing` | owner only |
| POST | `/api/org/routing/assign` | owner only |
| POST | `/api/org/routing/distribute` | owner only |
| PATCH | `/api/org/weekly-report` | owner only |
| GET | `/api/org/channel-partners` | owner only |
| PATCH | `/api/org/channel-partners/settings` | owner only |
| PATCH | `/api/org/channel-partners/:id` | owner only |
| POST | `/api/org/deals/:leadId` | owner only |
| GET | `/api/org/requests` | owner only |
| POST | `/api/org/requests` | owner only |
| GET | `/api/org/team` | owner only |
| POST | `/api/org/team` | owner only |
| POST | `/api/org/team/bulk` | owner only |
| POST | `/api/org/team/:id/set-password` | owner only |
| PATCH | `/api/org/team/:id` | owner only |
| POST | `/api/org/team/:id/reset-password` | owner only |
| GET | `/api/billing` | owner only |
| GET | `/api/billing/quote` | owner only |
| GET | `/api/billing/coupon/validate` | owner only |
| POST | `/api/billing/coupon/validate` | owner only |
| POST | `/api/billing/checkout` | owner only |
| POST | `/api/billing/checkout/cancel` | owner only |
| POST | `/api/billing/verify` | owner only |
| POST | `/api/billing/verify-order` | owner only |
| GET | `/api/billing/invoices/:id/pdf` | owner only |
| POST | `/api/billing/invoices/:id/resend` | owner only |
| POST | `/api/billing/cancel` | owner only |
| POST | `/api/billing/addon-checkout` | owner only |
| POST | `/api/billing/addon-verify` | owner only |
| POST | `/api/admin-auth/login` | public (no login; secured by token/signature) |
| POST | `/api/admin-auth/refresh` | public (no login; secured by token/signature) |
| POST | `/api/admin-auth/logout` | public (no login; secured by token/signature) |
| GET | `/api/admin-auth/me` | public (no login; secured by token/signature) |
| POST | `/api/admin-auth/change-password` | public (no login; secured by token/signature) |
| GET | `/api/inbound/form/:key` | public (no login; secured by token/signature) |
| POST | `/api/inbound/leads/:key` | public (no login; secured by token/signature) |
| POST | `/api/inbound/google-ads/:key` | public (no login; secured by token/signature) |
| GET | `/api/reports` | owner only |
| GET | `/api/reports/budget` | owner only |
| PATCH | `/api/reports/budget` | owner only |
| POST | `/api/reports/budget/send` | owner only |
| GET | `/api/quotes/public/:token` | public (no login; secured by token/signature) |
| GET | `/api/quotes` | any of leads + whatsappLeads + inbox |
| POST | `/api/quotes/preview` | any of leads + whatsappLeads + inbox |
| POST | `/api/quotes` | needs leadEdit |
| DELETE | `/api/quotes/:id` | needs leadEdit |
| POST | `/api/quotes/:id/send-whatsapp` | needs chatReply |
| GET | `/api/cp/me` | public (no login; secured by token/signature) |
| GET | `/api/cp/me/leads` | public (no login; secured by token/signature) |
| POST | `/api/cp/me/leads` | public (no login; secured by token/signature) |
| GET | `/api/cp/me/inventory` | public (no login; secured by token/signature) |
| GET | `/api/cp/:slug/info` | public (no login; secured by token/signature) |
| POST | `/api/cp/:slug/register` | public (no login; secured by token/signature) |
| POST | `/api/cp/:slug/login` | public (no login; secured by token/signature) |
| GET | `/api/voice/settings` | owner only |
| PATCH | `/api/voice/settings` | owner only |
| GET | `/api/voice/calls` | owner only |
| GET | `/api/voice/history` | owner only |
| DELETE | `/api/voice/history/:id` | owner only |
| DELETE | `/api/voice/history` | owner only |
| GET | `/api/voice/leads` | owner only |
| POST | `/api/voice/queue` | owner only |
| POST | `/api/voice/queue/cancel` | owner only |
| POST | `/api/voice/call/:leadId` | owner only |
| POST | `/api/voice/test-call` | owner only |
| GET | `/api/platform/stats` | public (no login; secured by token/signature) |
| GET | `/api/platform/orgs` | public (no login; secured by token/signature) |
| GET | `/api/platform/orgs/:id` | public (no login; secured by token/signature) |
| PATCH | `/api/platform/orgs/:id` | public (no login; secured by token/signature) |
| GET | `/api/platform/orgs/:id/email` | public (no login; secured by token/signature) |
| POST | `/api/platform/orgs/:id/email-credit` | public (no login; secured by token/signature) |
| POST | `/api/platform/orgs/:id/email-unpause` | public (no login; secured by token/signature) |
| POST | `/api/platform/orgs/:id/payments` | public (no login; secured by token/signature) |
| POST | `/api/platform/orgs/:id/support-session` | public (no login; secured by token/signature) |
| GET | `/api/platform/payments` | public (no login; secured by token/signature) |
| GET | `/api/platform/payments/:id/pdf` | public (no login; secured by token/signature) |
| GET | `/api/platform/admins` | public (no login; secured by token/signature) |
| POST | `/api/platform/admins` | public (no login; secured by token/signature) |
| PATCH | `/api/platform/admins/:id` | public (no login; secured by token/signature) |
| GET | `/api/platform/requests` | public (no login; secured by token/signature) |
| PATCH | `/api/platform/requests/:id` | public (no login; secured by token/signature) |
| GET | `/api/platform/activity` | public (no login; secured by token/signature) |
| GET | `/api/platform/revenue` | public (no login; secured by token/signature) |
| GET | `/api/platform/coupons` | public (no login; secured by token/signature) |
| POST | `/api/platform/coupons` | public (no login; secured by token/signature) |
| PATCH | `/api/platform/coupons/:id` | public (no login; secured by token/signature) |
| POST | `/api/platform/coupons/:id/disable` | public (no login; secured by token/signature) |
| GET | `/api/platform/coupons/:id/redemptions` | public (no login; secured by token/signature) |
| GET | `/api/platform/plan-offers` | public (no login; secured by token/signature) |
| PUT | `/api/platform/plan-offers` | public (no login; secured by token/signature) |
| DELETE | `/api/platform/plan-offers/:id` | public (no login; secured by token/signature) |

(Routes under /api/platform/* are protected by the separate platform-admin token (adminAuth), not by the tenant guards — the script lists them as 'public' only because it looks for tenant guards.)
