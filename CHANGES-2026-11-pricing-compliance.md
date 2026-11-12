# Nov 2026 — India + UAE pricing, plan gating, bulk messaging safety

## 1. Pricing (src/config/plans.js)
| Plan | India / month | UAE / month | Setup (IN / AE) | Logins (IN / AE) | Bulk WA + email |
|---|---|---|---|---|---|
| Solo (UAE only) | — | AED 249 | — / 0 | — / 1 | No |
| Starter | ₹3,999 | AED 499 | ₹5,000 / AED 500 | 1 / 3 | No |
| Growth | ₹7,999 | AED 999 | ₹10,000 / AED 2,400 | 5 / 5 | Yes |
| Builder Pro | ₹14,999 | AED 1,999 | ₹25,000 / AED 5,000 | 10 / 10 | Yes |
| Enterprise | from ₹30,000 | from AED 3,999 | contact sales | unlimited | Yes |

Billing cycles: monthly, 6 months (×6), yearly (×10 = 2 months free). Setup fee is waived on 6-month and yearly prepay.
India adds 18% GST. UAE adds `AE_TAX_RATE` (default 0 — export of services; set 0.05 if you register for UAE VAT).
Meta WhatsApp conversation charges are not in the plan price; they are passed through the wallet (`metaBilling`, Growth and above).

Per-company changes from the Platform admin: `region`, `featureOverrides` (e.g. `{ "bulkWhatsapp": true }`), `limitOverrides`.

### Existing Starter customers (e.g. Agarwal Homez)
They had bulk messaging and 3 logins. Keep them whole:
```
npm run plans:grandfather            # dry run
npm run plans:grandfather -- --apply
```

## 2. Bulk WhatsApp & email safety (src/services/compliance/messagingPolicy.js)
- **Policy acceptance:** every campaign launch needs two ticks (consent confirmation + policy). Stored on the campaign (`compliance`) and in the AuditLog. Public policy: `/messaging-policy` (API: `GET /api/public/messaging-policy`).
- **Opt-out:** STOP / UNSUBSCRIBE / बंद / إيقاف (and START to re-subscribe) on WhatsApp. These are matched only when they are the whole message. The contact is opted out, pending jobs are cancelled, a confirmation is sent, and the AI does not reply.
- **Email:** footer with company name, postal address, the reason for receiving the email and an unsubscribe link. Also sends `List-Unsubscribe` and `List-Unsubscribe-Post` (one-click, RFC 8058; Gmail/Yahoo bulk-sender rule). Brevo bounce, spam and unsubscribe webhooks suppress the contact.
- **Suppression:** opted-out, do-not-contact, bounced and complained contacts are skipped at launch and again at send time.
- **Quiet hours:** 21:00–09:00 local time (Asia/Kolkata or Asia/Dubai, per region). Campaign jobs wait until morning; lead replies and the opening message are not held.
- **Frequency:** at most one marketing message per contact per 24h and 3 per week.
- **Daily caps:** WhatsApp 1,000/day, email 2,000/day. Email warm-up for new senders: 100 → 300 → 1,000.
- **Auto-pause:** a campaign pauses itself when, after 50 sends, any of these limits is crossed: fail > 20%, opt-out > 5%, bounce > 5%, complaint > 0.3%. WhatsApp campaigns also pause when Meta marks the number RED, FLAGGED or downgraded. The owner gets a notification. The Platform admin can clear it with `clearAutoPause`.
- **Consent tracking:** `Lead.consent.whatsapp/email` (status, source, time). Inbound enquiries are recorded as `opted_in` with their source.

## 3. New env vars (all optional)
```
AE_TAX_RATE=0            AE_TAX_LABEL=VAT
RAZORPAY_INTL_ENABLED=false   # true once Razorpay international (AED) payments are approved
AED_TO_INR=25.8          # MRR reporting only
PUBLIC_API_URL=https://api.visitsly.com   # one-click unsubscribe links hit the API directly
UNSUBSCRIBE_SECRET=<long random string>   # falls back to the JWT access secret
MARKETING_MIN_GAP_HOURS=24  MARKETING_MAX_PER_WEEK=3
QUIET_HOURS_START=21:00     QUIET_HOURS_END=09:00
WA_DAILY_LIMIT=1000         EMAIL_DAILY_LIMIT=2000   EMAIL_WARMUP=100,300,1000
SAFETY_MIN_SAMPLE=50 SAFETY_MAX_FAIL_RATE=0.2 SAFETY_MAX_OPTOUT_RATE=0.05
SAFETY_MAX_BOUNCE_RATE=0.05 SAFETY_MAX_COMPLAINT_RATE=0.003
RAZORPAY_PLAN_<CODE>_<CYCLE>[_AE]=plan_xxx   # optional fixed Razorpay plan ids
```

## 4. One-time setup steps
1. Meta App → WhatsApp → Webhooks: subscribe to the **phone_number_quality_update** field.
2. Brevo webhooks: enable hard bounce, invalid, spam and unsubscribed events.
3. Mongo: the old unique index on `razorpayplans` {code, cycle, amountPaise} may need dropping. It is replaced by {code, cycle, amountPaise, currency}:
   `db.razorpayplans.dropIndex("code_1_cycle_1_amountPaise_1")`
4. Each customer fills **Settings → Bulk messaging safety → postal address**. This is required in email footers.
5. Get the policy text (`src/controllers/policyController.js`) reviewed by a lawyer for India (DPDP Act 2023, TRAI) and UAE (PDPL, TDRA).
