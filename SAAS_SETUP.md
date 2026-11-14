# PropAI SaaS — setup and go-live

PropAI now ships as **three apps**:

| App | Folder / zip | Who uses it | Example URL |
|---|---|---|---|
| Backend API | `propai-saas-backend` | everything | `api.propai.in` |
| Customer app | `propai-saas-frontend` | brokers, agencies, builders and their teams; also the public lead form (`/f/…`) and the channel partner portal (`/cp/…`) | `app.propai.in` |
| Admin panel | `propai-admin-panel` | PropAI staff only (you) | `admin.propai.in` |

The admin panel has its **own login, its own JWT secrets and its own cookie**. A customer token can never open it, and an admin cannot log into the customer app. To help a customer, open their company and click **Open in customer app**. This starts a 60-minute support session in a new tab. The session is logged, and the customer app shows a "PropAI support mode" banner.

PropAI now runs many companies (brokers, agencies and builders) from **one deployment**.
Each company has its own login(s), its own WhatsApp number, settings, leads, chats,
properties and bill. Companies never see each other's data.

## How it works

| Piece | What it does |
|---|---|
| `Organization` (company) | Plan, trial and subscription status, monthly usage, and that company's WhatsApp number. The access token is AES-encrypted. |
| Workspace id | Every existing record keeps `ownerId`. In SaaS mode `ownerId` is the company owner's user id, so the whole team shares one workspace. |
| Tenant context | Each request, Meta webhook, queued job and scheduler tick runs "inside" one company (`src/context/tenantContext.js`). `env.metaWhatsapp`, settings, the AI and email sender name automatically use that company's values. |
| Auto-scoping | A Mongoose plugin (`src/context/tenantScopePlugin.js`) adds `ownerId` to every query on tenant models inside a company context. Even a query that forgets it cannot read another company's data. |
| Webhook routing | One Meta app webhook serves everyone. Each message is routed by `metadata.phone_number_id` to the company that owns that number. |
| Bulk worker | Runs companies in parallel (`BULK_WORKER_CONCURRENCY`). The send gap and rate-limit pause apply per company, so one company's problem never stops another's sending. |
| Roles | **owner**: everything including billing. **manager**: everything except billing. **agent**: leads, chats, visits and follow-ups only, with no bulk sends, export or settings. |
| Plans and limits | `src/config/plans.js`: users, contacts, AI conversations per month, campaigns per month. The platform admin can override limits or set a custom price per company. |
| Billing | Razorpay Subscriptions: card, UPI AutoPay or e-mandate, with GST included in the amount. The setup fee is charged once as an add-on. Offline UPI or bank payments can be recorded from the Platform panel. |
| Lapsed account | When a trial ends, a payment fails past the grace period, or an account is suspended, the company becomes **read-only**: data stays visible and exportable, the AI stops replying, and bulk jobs pause. Jobs resume automatically after payment. |
| Meta charges | Each customer's WABA is their own, and they add their own payment method in WhatsApp Manager. PropAI never carries their Meta bill. The Meta billing dashboard shows their usage. |

## Customer features (all plans unless noted)

- **Lead sources** (Growth → Lead sources): hosted form link, website form snippet, n8n/Zapier webhook, Google Ads lead form webhook, email forwarding for portal leads (99acres / MagicBricks / Housing / NoBroker), and native Facebook/Instagram Lead Ads. Every lead is de-duplicated, round-robin assigned, and gets the opening WhatsApp right away.
- **Lead routing**: round-robin between chosen agents, an option for agents to see only their own leads, one-click distribution of unassigned leads, and manual assignment from the chat panel.
- **Reports**: funnel, source-wise results (reply %, visit %, bookings, revenue), team performance and a daily trend. A weekly WhatsApp report goes to the owner every Monday.
- **Cost sheets**: unit price breakup (rate × area, PLC/parking/club, discount, GST, stamp duty, registration) with a payment plan, a branded PDF link, and sending on WhatsApp inside the 24-hour window.
- **Channel partner portal** (`/cp/<company-slug>`): brokers register and you approve them. They register customers with lead protection, track each lead's stage, see inventory and brochures, and see their commission. Use **Mark booked** in the chat panel with the deal value to drive commission and reports.
- **AI voice calling** (Bolna): calls on demand from the chat panel, or auto-calls fresh leads that don't reply on WhatsApp. The result webhook writes a summary to the lead, books the visit and meters minutes.
- **Multiple WhatsApp numbers** (Builder: 2, Enterprise: unlimited, or the add-on): each buyer is pinned to the number they used. Replies and campaigns can go from a chosen number.
- **White-label** (Enterprise, set in the admin panel): product name, logo and custom domain. The login page and sidebar show the customer's brand, and the domain is allowed by CORS automatically.
- **Add-on requests** from Plan & Billing go to the admin panel's Requests page. Once paid, set the add-on on the company page.

## Extra setup for the new features

| Feature | What to do |
|---|---|
| Admin panel | Deploy `propai-admin-panel` with `VITE_API_BASE_URL`. On the backend set `ADMIN_URL`, `ADMIN_JWT_ACCESS_SECRET` and `ADMIN_JWT_REFRESH_SECRET`, then run `npm run seed:superadmin`. |
| Links shown to customers | Set `PUBLIC_API_URL` to the backend's public URL. |
| Portal leads by email | Brevo inbound parsing on your receiving subdomain (`EMAIL_INBOUND_DOMAIN`), already used for email replies. Forwarded mails to `leads-<key>@that-domain` become leads. |
| Facebook/Instagram Lead Ads | In PropAI's Meta app, add a **Page** webhook subscription to field `leadgen` at `https://<backend>/api/webhooks/meta-leads` with the same verify token. Get App Review for `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement` and `pages_manage_ads`. |
| Google Ads | Nothing on your side. The customer copies the URL and key from Lead sources. |
| AI calling | The customer creates a Bolna agent and pastes the API key and agent id. Bolna's webhook URL is shown on the AI calling page. Bill the ₹7/min add-on from the minutes shown on the company page. |
| Cost sheet PDFs | Need `pdfkit`, which is already in package.json. Run `npm ci`. |

## Go-live checklist

1. **Deploy** this backend and the frontend as before (Render plus Vercel/Netlify).
2. **Env**: copy the new block from `.env.example`. At minimum set `SUPER_ADMIN_EMAILS`, `ENCRYPTION_KEY` (long random; never change it afterwards, because stored tokens depend on it), and `JWT_*`.
3. **Super-admin login**:
   `SUPER_ADMIN_EMAIL=you@deific.in SUPER_ADMIN_PASSWORD='long-password' npm run seed:superadmin`
4. **Move Agarwal Homez in** (one time, safe to re-run):
   `MIGRATE_ORG_NAME="Agarwal Homez" MIGRATE_PLAN=starter MIGRATE_PRICE=3500 npm run saas:migrate`
   Their leads, chats and properties stay as they are. The WhatsApp token moves from `.env` onto the company, encrypted.
5. **Razorpay** (Dashboard → Settings → API keys and Webhooks):
   - Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
   - Add a webhook at `https://<backend>/api/webhooks/razorpay` with these events: `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `payment.failed`. Set the same secret in `RAZORPAY_WEBHOOK_SECRET`.
   - Plans are created automatically on the first checkout. The log prints each plan id so you can pin it in env.
6. **Meta (Tech Provider + Embedded Signup)** so customers can click **Connect WhatsApp**:
   - In the Meta App (Business type), add WhatsApp and Facebook Login for Business. Complete Business Verification and App Review for `whatsapp_business_management` and `whatsapp_business_messaging`. Then become a **Tech Provider**.
   - Under Facebook Login for Business → Configurations, create a WhatsApp Embedded Signup configuration and put its id in `META_ES_CONFIG_ID`.
   - Add your frontend domain to the App Domains list and to "Allowed domains for the JavaScript SDK".
   - Keep the single webhook at `https://<backend>/api/whatsapp/webhook`.
   - Until approval comes through, customers (or you, for them) can use **Manual connect**: a System User token, Phone Number ID and WABA ID.
7. **Test**: sign up a test company at `/signup`, connect a number, send a template, and reply from your phone. Then check that the chat shows only in that company.

## API added

- `POST /api/auth/signup`, `POST /api/auth/change-password`
- `GET/PATCH /api/org`, `PATCH /api/org/onboarding`
- `GET /api/org/whatsapp`, `POST /api/org/whatsapp/embedded-signup`, `POST /api/org/whatsapp/manual`, `POST /api/org/whatsapp/disconnect`, `PATCH /api/org/whatsapp/opening-template`
- `GET/POST /api/org/team`, `PATCH /api/org/team/:id`, `POST /api/org/team/:id/reset-password`
- `GET /api/billing`, `GET /api/billing/quote`, `POST /api/billing/checkout`, `POST /api/billing/verify`, `POST /api/billing/cancel`
- `POST /api/webhooks/razorpay`
- `GET /api/public/plans`
- Admin panel auth: `POST /api/admin-auth/login | refresh | logout | change-password`, `GET /api/admin-auth/me`
- Admin panel (admin token only): `GET /api/platform/stats | revenue | orgs | payments | admins | requests | activity`, `GET/PATCH /api/platform/orgs/:id`, `POST /api/platform/orgs/:id/payments`, `POST /api/platform/orgs/:id/support-session`, `POST/PATCH /api/platform/admins`, `PATCH /api/platform/requests/:id`
- Lead capture (public): `GET /api/inbound/form/:key`, `POST /api/inbound/leads/:key`, `POST /api/inbound/google-ads/:key`, `GET/POST /api/webhooks/meta-leads`, `POST /api/webhooks/voice/:key`
- Growth: `/api/org/lead-sources*`, `/api/org/routing*`, `/api/org/weekly-report`, `/api/org/requests`, `/api/org/whatsapp/numbers`, `/api/org/channel-partners*`, `/api/org/deals/:leadId`, `/api/reports`, `/api/quotes*` (public PDF `/api/quotes/public/:token`), `/api/voice/*`
- Channel partner portal: `/api/cp/:slug/info | register | login`, `/api/cp/me`, `/api/cp/me/leads`, `/api/cp/me/inventory`
- White-label: `GET /api/public/branding?host=`

## Still on the roadmap

- Ownership transfer, and deleting a company with a full data export (DPDP Act)
- Wallet-based Meta billing with markup, if you later want to resell Meta messages
- Paying for add-ons by self-serve Razorpay checkout (today: request → payment link → admin sets the add-on)
- Direct 99acres / MagicBricks APIs (today: email forwarding, which works for every portal)


## Email-verified signup and 7-day trial

Public signup creates a pending user record only. The person must open the one-time email verification link before PropAI creates their company workspace and starts the trial clock. Unverified accounts cannot log in or refresh a session. Expired pending signup records are removed by the explicitly ensured MongoDB TTL index (the index is created at startup, including in production).

Production configuration:

```env
SAAS_MODE=true
SIGNUP_ENABLED=true
TRIAL_DAYS=7
APP_BASE_URL=https://your-customer-crm-domain.example
CLIENT_URL=https://your-customer-crm-domain.example
BREVO_API_KEY=your_brevo_transactional_api_key
BREVO_FROM_EMAIL=verified-sender@your-domain.example
BREVO_FROM_NAME=PropAI
EMAIL_VERIFICATION_EXPIRES_HOURS=24
# Optional extra disposable domains, comma-separated:
DISPOSABLE_EMAIL_DOMAINS=example-disposable.com,another-temp-domain.example
```

`BREVO_FROM_EMAIL` must be verified/authorized in Brevo and the domain should have its sender authentication configured. In production, signup fails safely if verification email delivery is not configured or fails. In local development, the verification link is printed to the backend log when Brevo is not configured. A blocklist of common disposable email domains is applied at signup; email ownership is confirmed by the verification link, not by syntax alone.

The 7-day period starts when the email is successfully verified, not when the signup form is submitted. Existing verified accounts are preserved during migration. Paid plans retain the existing monthly recurring billing option; yearly billing remains optional.
