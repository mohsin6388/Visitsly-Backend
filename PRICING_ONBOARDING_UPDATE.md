# Signup, onboarding, country pricing, plans and trial (Nov 2026)

## What changed
- **Signup** asks only mobile (with dial code), email and password. Company, name, city, country and business type are optional in `POST /api/auth/signup` (older clients keep working). The phone is sent as `+<code><number>`; a number without `+` uses the detected country.
- **Verify email** creates the workspace with placeholders (`My Company`, detected country, `onboarding.profileDone = false`). The currency is provisional until onboarding.
- **Onboarding wizard** (`/onboarding` in the app): name → company → country → city → Broker / Agency / Builder.
  - `PATCH /api/org/profile` (owner): saves everything, sets `currency = currencyForCountry(country)`, sets `profileDone` and `companyDone`, writes an `org.profile` audit log.
  - `PATCH /api/org/profile/draft` (owner): saves answers after each step so the owner can resume.
  - After `profileDone`, country and currency can only be changed by a platform admin (`PATCH /api/platform/orgs/:id` with `country`). `PATCH /api/org` returns 403 `COUNTRY_LOCKED`.
  - `profileDone` is returned in the org summary, `/auth/login` and `/auth/me`.
- **Country detection**: `GET /api/public/geo` → `{ country }` from `CF-IPCountry`, then `x-vercel-ip-country`, then optional `GEO_LOOKUP_URL` (≤1.5 s, cached), else `null`. The frontend falls back to the browser guess and caches the result in `sessionStorage`.
- **Plans** (`config/plans.js`, limits / features / copy only): Starter 1 login · 1,000 AI chats; Growth 5 · 3,000; Builder Pro 10 · 10,000; Enterprise unlimited, custom pricing. No setup fee anywhere.
- **Prices** (`config/pricing.js`) come only from `PRICE_*` env vars (see `.env.example`), with safe defaults and a startup warning for invalid values. Currencies: INR, AED, USD (IN → INR, AE → AED, everything else → USD).
- **Feature gates (server-side)**, all returning 403 `PLAN_LIMIT` (the app shows its Upgrade prompt):

  | Feature flag | Enforced at |
  |---|---|
  | `bulkWhatsapp` | campaign launch (WhatsApp), `POST /leads/start-conversations` for more than one lead, bulk worker (campaign jobs) |
  | `emailCampaigns` | campaign launch (email), email account save/test, email template create/update, bulk worker (email jobs) |
  | `teamRouting` | `PATCH /org/routing`, `/routing/assign`, `/routing/distribute`, auto-assign of new leads |
  | `autoFollowUps` | follow-up scheduler: without it, "auto" works as "remind" |
  | `inventory` | property import (preview / confirm), export, bulk delete |
  | `multiProjectBot` | project sites: brochure upload and site edit |
  | `metaLeadAds` | Meta page list / connect; leadgen webhook (lead skipped, owner notified) |
  | `weeklyReports` | `PATCH /org/weekly-report`, weekly scheduler |
  | `aiCalling` | voice call / test call / settings, `placeCall`, auto-call scheduler, visit-confirmation calls (WhatsApp fallback) |

  `portalIntegrations`, `customWorkflows` and `dedicatedManager` are listed for Enterprise but are not gated in code.
- **AI calling**: included minutes per plan (`<PLAN>_VOICE_MINUTES_INCLUDED`, default 0 / 30 / 100). Prepaid minute packs add to them. `GET /api/voice/settings` returns included, used and overage minutes; `costThisMonth` is the overage only.
- **Free trial**: 1 login, 50 contacts, 50 bulk WhatsApp messages, 50 AI conversations, 15 AI replies per contact, 1 campaign, 1 number. No email and no AI calling. AI-conversation and campaign limits count the whole trial (`usageTotals`), not one month.

## Migrations (run automatically at boot, once, tracked in `app_migrations`)
- `2026-11-org-profile-done-existing`: every existing company gets `onboarding.profileDone = true`, so it skips the wizard.
- `2026-11-grandfather-plan-limits-features`: every company on a paid plan gets `limitOverrides` equal to its old plan limits (unless the admin had already overridden a key) and `featureOverrides` for every feature it could use before.
- `2026-11-retired-currencies-to-usd`: companies on SAR / GBP / EUR … without a live subscription move to their country's currency.

To re-run one, delete its document from `app_migrations` and restart.

## Tests
`npm run test:saas`: 21 checks, no database needed.

# Round 2 (18 Nov 2026): campaigns, AI calling, chat, billing

- **Campaigns**: each job saves the contact's name / phone / email, so deleted contacts still show in the campaign ("Removed from contacts"). Deleting a contact cancels its unsent jobs. `DELETE /api/campaigns/:id` deletes a finished or cancelled campaign and its history. Schedules take `durationDays`: at most `dailyLimit × durationDays` contacts are messaged (the rest are reported as `notScheduled`); with fewer contacts the campaign ends early. The "Send to" filter was removed from the launcher. A live panel at the top of the app shows who is being messaged while a bulk send runs.
- **Errors**: failed messages show a small "Not delivered" button; the popup explains the reason and links to the fix (Meta payment settings, WhatsApp setup, templates). Long error text wraps.
- **AI calling**:
  - The page has two sections: visit confirmation calls, and AI calling leads.
  - **Visit confirmation calls**: call history with delete and clear, a "Visit confirmed by call" tag, and a visit-day reminder call (`visitConfirm.reminderCall`, on by default).
  - **AI calling leads**: "To call" lists contacts from Upload Data; selecting them queues the calls (`POST /api/voice/queue`). "Called" shows the history with what each call produced. An optional company calling script is saved in `Organization.voice.script`.
  - The queue calls one contact at a time per company (`VOICE_BULK_CONCURRENCY`) during calling hours.
  - When the customer reschedules on a call, the new date is confirmed again on WhatsApp (YES / NO).
- **Upload Data**: a call icon on each contact (shows an upgrade popup on plans without AI calling) and "Send to AI calling" for selected contacts.
- **Billing**: if Razorpay subscriptions can't be created, checkout automatically takes a one-time payment for the month or year (`/api/billing/verify-order`, order webhook). `RAZORPAY_PAYMENT_MODE=order` forces one-time payments. Plans paid this way show "Renew" and go read-only after the grace days once the period ends.
- **Language**: all UI text, API messages and notifications are in English. Messages sent to customers stay in the customer's chosen language.
