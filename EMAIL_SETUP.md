# Email campaigns via Brevo (Nov 2026)

Campaign email is sent through the **platform Brevo account**. There is no client SMTP any more.

**Per company**
1. Owner opens *Email → Setup*, reads the 10 reputation guidelines and ticks the checkbox.
2. Enters an **official company email** (free / personal / disposable domains are refused — list in
   `src/config/emailDomains.js`, extend with `EMAIL_BLOCKED_DOMAINS`).
3. We create a Brevo sender (`POST /v3/senders`); Brevo emails a **6-digit code** to that address; the Owner types it
   (`PUT /v3/senders/{id}/validate`). Brevo has no documented "resend" call, so "Send a new code" deletes and re-creates the sender.
4. We add the domain (`POST /v3/senders/domains`), show the DNS records, and "Check DNS" re-reads
   (`GET /v3/senders/domains/{domain}`) and then calls `PUT .../authenticate`. A background job re-checks pending domains every 30 min.
5. Campaigns can launch only when the sender is `verified` and (with `EMAIL_REQUIRE_DOMAIN_AUTH=true`) the domain is `authenticated`.

**Sending:** From = the verified sender (display name = company), Reply-To = the same address. Unsubscribe link,
tracking tags, idempotency key, `EmailMessage` tracking and Brevo webhooks are unchanged.

**Wallet (per email):** price = `EMAIL_COST_PER_EMAIL` + `EMAIL_MARGIN_PER_EMAIL` (default 0.20 + 0.10 = ₹0.30), +18 % GST on
the recharge invoice (₹0.354 all-in). Stored as integer milli-rupees. Clients see only the all-in rate; cost/margin are
visible in the platform admin API (`GET /api/platform/orgs/:id/email`). Recharge = add-on `emailCredit` through the same Razorpay
flow and invoices as AI-calling minutes. Debit is atomic and idempotent per job; an empty wallet *pauses* the jobs and
they resume on recharge; only our-side failures are refunded.
Admin credit: `POST /api/platform/orgs/:id/email-credit {emails, note}` (audit-logged). After a safety auto-pause:
`POST /api/platform/orgs/:id/email-unpause`.

**Safety:** daily cap per company (IST day) `EMAIL_DAILY_CAP_PER_COMPANY`; auto-pause when, over the last 7 days and at least
`EMAIL_BOUNCE_MIN_SAMPLE` sent, bounce > `EMAIL_MAX_BOUNCE_RATE` or complaints > `EMAIL_MAX_COMPLAINT_RATE`; unsubscribed,
invalid and previously bounced addresses are skipped without charge.

**.env**
```
BREVO_API_KEY=...            # needs access to Senders & Domains API
BREVO_FROM_EMAIL=...         # platform mail (verify / reset / invites)
PUBLIC_API_URL=https://api.visitsly.com   # for unsubscribe links
EMAIL_COST_PER_EMAIL=0.20
EMAIL_MARGIN_PER_EMAIL=0.10
EMAIL_REQUIRE_DOMAIN_AUTH=true
EMAIL_DAILY_CAP_PER_COMPANY=1000
EMAIL_BOUNCE_MIN_SAMPLE=100
EMAIL_MAX_BOUNCE_RATE=0.05
EMAIL_MAX_COMPLAINT_RATE=0.003
```
