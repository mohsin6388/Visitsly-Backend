# Email (client ka apna official email)

Har client **Email → Setup** me apna official email connect karta hai (SMTP + App Password).
Campaign usi email se jati hai, aur customer ka reply seedha client ke apne inbox me aata hai.

- Gmail: 2-Step Verification on karke Google Account → Security → App Passwords se 16-digit password banayein.
- Outlook / Zoho / Hostinger etc.: provider ki SMTP host + port (587 ya 465).
- Connect karte waqt login verify hota hai; galat password save nahi hota. Password encrypted store hota hai (`ENCRYPTION_KEY` prod me zaroor set karein).
- **Email → Email details**: sent / failed / pending, date filter, din ke hisaab se count.
- "Sent" = email server ne accept kar li. Inbox delivery / bounce SMTP me track nahi hota.

`BREVO_*` env ab sirf platform ke apne emails (verify email, password reset) ke liye hai.

---

# Bulk email — how it works now (Nov 2026)

**Two senders, one worker**

1. **Client's own mailbox (default, recommended).** Any SMTP provider: Gmail, Outlook/365, Zoho, Yahoo,
   Hostinger, GoDaddy, or an email-API relay — **Brevo SMTP, SendGrid, Mailgun, Amazon SES** — or "Other".
   The client picks the provider on *Email → Setup*, we verify the login before saving.
2. **Platform Brevo (optional fallback).** Only when `BREVO_CAMPAIGN_FALLBACK=true` and the company has
   *not* connected an email. Mails go out from `BREVO_FROM_EMAIL` under the company's name, replies go to the
   company owner's email, and Brevo webhooks update delivered / bounced. Capped at
   `BREVO_FALLBACK_DAILY_PER_COMPANY` (default 200) per company per day.

**Safety built into the worker**

* **Daily cap (IST).** Each account has a safe default (Gmail 450, Outlook 250, Zoho 200, Yahoo 400;
  email-API providers = none) and the client can set their own. When reached, that company's email pauses
  until midnight IST, jobs stay queued, owner is notified, and it resumes by itself.
* **Provider throttling** (Gmail 5.4.5, Outlook 4.7.x, Zoho/Hostinger "ratelimit", SES "Maximum sending rate",
  HTTP 429) → pause 1 hour, attempt not burnt. SMTP 421 → 1 minute pause. Other 4xx → retry with backoff.
  5xx bad mailbox → that lead fails, the rest continue. Login failure → pause + owner notified to reconnect.
* **Unsubscribe.** Every bulk email has a visible link plus `List-Unsubscribe` / one-click headers.
  The link sets `lead.emailOptedOut` (email only; WhatsApp is unaffected). Opted-out and WhatsApp-STOP leads are
  skipped. **Needs `PUBLIC_API_URL` in .env** (e.g. `https://api.visitsly.com`) or the link is left out.
* One email at a time per company with a `BULK_EMAIL_INTERVAL_MS` (2 s) gap + random jitter.

**.env**
```
PUBLIC_API_URL=https://api.visitsly.com        # required for unsubscribe links
BREVO_CAMPAIGN_FALLBACK=false                  # true = companies without own SMTP send via platform Brevo
BREVO_FALLBACK_DAILY_PER_COMPANY=200
BULK_EMAIL_INTERVAL_MS=2000
```

**Deliverability checklist for the client** (we cannot do this for them): the sending domain should have SPF +
DKIM (+ DMARC) set up in their DNS; use a real company mailbox, not a brand-new one, and warm up slowly.
