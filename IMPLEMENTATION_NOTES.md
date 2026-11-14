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
- New: lead capture (`leadCapture.js`, `portalParsers.js`, `metaLeadAds.js`, `inboundController.js`), round-robin routing (`routing.js`), reports and weekly report (`reportsService.js`), cost sheets with a pdfkit PDF (`Quote`, `quoteService.js`), channel partner portal (`ChannelPartner`, `cpController.js`), Bolna AI calling (`CallLog`, `voiceService.js`), extra WhatsApp numbers (`Organization.extraNumbers` and `tenantContext.runWithNumber`), add-ons and white-label (`Organization.addons/branding`), and customer requests (`PlatformRequest`).
- Tests: 105 end-to-end API checks and 14 browser checks (customer app, public form, CP portal, admin panel, support session, mobile width).
