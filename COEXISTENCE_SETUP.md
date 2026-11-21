# WhatsApp Coexistence — kya add hua aur kya setup karna hai

## Naya kya hai
Dashboard mein jahan "WhatsApp number" connect hota hai (WhatsApp page → ConnectWhatsApp), ab shuru mein 2 option cards dikhte hain:
1. **Maujooda WhatsApp Business app number (Coexistence)** — phone app + Visitsly dono chalte hain, PIN nahi chahiye.
2. **Naya number (Cloud API only)** — purana flow, PIN ke saath.

Connect hone ke baad:
- **Test message card**: apna number daalo, Visitsly us par test message bhejta hai.
- Coexistence ho to **sync status card** (contacts / chat history, progress, retry button, 24h deadline).

## Backend changes
- `services/saas/whatsappConnect.js`: coexistence prepare/complete (no /register, is_on_biz_app check), `startCoexistenceSync` (smb_app_data: smb_app_state_sync phir history), `sendTestMessage`, publicView/health/disconnect updates.
- `services/whatsapp/coexistenceService.js` (NEW): webhooks `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update (PARTNER_REMOVED)`.
- `services/whatsapp/webhookHandler.js`: naye fields dispatch; purani chat ka customer dobara likhe to conversation ai_active ho jati hai.
- Routes: `POST /api/org/whatsapp/test-message`, `POST /api/org/whatsapp/coexistence/sync`.
- Models: Organization.whatsapp.isCoexistence / coexistence.*, Conversation.coexistenceImported, Message.source, Attempt.isCoexistence.
- Validator: complete-signup mein `pin` ab optional (naye number ke liye service khud check karti hai).

## .env
```
META_APP_ID=2316666552472184
META_ES_CONFIG_ID=1649881420262337     # Business App Onboarding wali config
META_WHATSAPP_API_VERSION=v27.0
META_WHATSAPP_APP_SECRET=...           # sirf .env mein
META_WHATSAPP_VERIFY_TOKEN=...         # Meta webhook mein bhi wahi
```
(Exact variable names aapke `config/env.js` ke hisaab se; jo pehle se set hain unhe hi use karein.)

## Meta dashboard
- App Domains + Facebook Login for Business → JS SDK allowed domains (HTTPS) mein dashboard domain.
- Webhook: callback `https://<backend>/api/whatsapp/webhook`, subscribe: messages, account_update, history, smb_app_state_sync, smb_message_echoes.

## Dhyan rakhne wali baatein
- Sync 24 ghante ke andar hi ho sakta hai, har call ek baar. Background retry (0s, 30s, 3m, 15m) hai; server restart ho jaye to dashboard ka "Sync dobara try karein" button use karein.
- Webhook payload parsing Meta docs ke hisaab se defensive likhi hai; real number se test karke dekhein (echo / history / contacts).
- Jin customers ka sirf BSUID aata hai (phone number nahi), unke echo/history abhi skip hote hain.
- History se bani conversations "paused" rehti hain (AI / auto follow-up nahi) jab tak customer khud dobara message na kare.
