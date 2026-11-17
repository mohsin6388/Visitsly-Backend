# AI calling — Plivo + ElevenLabs + Gemini (Groq fallback)

Platform-managed: clients do NOT set anything up. Visitsly owns the Plivo number and the ElevenLabs
voice. The only thing a client controls is the **main toggle** on *WhatsApp AI → Visit confirmation*
("AI call se confirm karein") — ON by default.

## 1. .env (backend)
```
# Telephony (Plivo) — Console → Overview → Auth ID / Auth Token
PLIVO_AUTH_ID=MAXXXXXXXXXXXXXXXXXX
PLIVO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
PLIVO_FROM_NUMBER=+91XXXXXXXXXX                 # your Plivo number (caller ID)
# optional, per country: PLIVO_FROM_NUMBERS_JSON={"IN":"+91XXXXXXXXXX","AE":"+971XXXXXXXXX"}

# Voice (ElevenLabs) — Profile → API key; Voice Library → your voice → "ID"
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxx
ELEVENLABS_VOICE_ID=xxxxxxxxxxxxxxxxxxxx
ELEVENLABS_MODEL_ID=eleven_flash_v2_5           # fast (recommended). eleven_multilingual_v2 = richer but slower
# optional, per language: ELEVENLABS_VOICES_JSON={"hi":"voiceA","en":"voiceB"}
VOICE_AGENT_NAME=Priya                          # name the agent says on the call
VOICE_AGENT_GENDER=female                       # female | male — MUST match your ElevenLabs voice (Hindi verbs follow it)

# Brain — Gemini first, Groq if Gemini is down / rate-limited (also used by the WhatsApp chatbot)
GEMINI_API_KEY=xxxxxxxx
GROQ_API_KEY=gsk_xxxxxxxx
# optional: GROQ_MODELS=llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant
# optional: GEMINI_VOICE_MODELS=gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite

# Plivo calls back to these URLs, so this MUST be your public HTTPS backend URL
PUBLIC_API_URL=https://api.yourdomain.com
VOICE_WEBHOOK_SECRET=put-a-long-random-string
```
Restart the backend. The log shows `[voice] AI calling ready (Plivo + ElevenLabs)` — or which env vars are missing.

Nothing to configure inside Plivo: every call carries its own answer / hang-up URLs
(`/api/webhooks/voice/plivo/<event>/<callId>?s=<secret>`). Only make sure:
* the Plivo number is voice-enabled and allowed to call the countries you need (India: complete Plivo's
  KYC / DLT requirements for outbound calls from an Indian number);
* the account has balance.

## 2. Test
*WhatsApp AI → Visit confirmation → Test call* → enter your mobile → you get a sample confirmation call
("…aapki Sample Project ki site visit kal subah 11 baje ke liye book hai. Kya aap aa paayenge?").
Answer "haan", "nahi", or a new day/time to hear how it responds.

## 3. The flow
1. **WhatsApp chatbot** invites the customer for a site visit and asks the day & time.
2. Customer says **yes** → visit is booked → owner gets an alert.
3. **Toggle ON:** within ~1 minute (inside calling hours, default 10:00–19:00 IST) the AI calls:
   * *haan / aa jaunga* → visit **confirmed** (owner alert + WhatsApp note with location).
   * *nahi* → the agent asks which other day/time suits, or when to follow up.
     New day/time → visit moved + confirmed. "Next month" → follow-up created, visit cancelled.
   * busy / unclear → "main WhatsApp par message kar deti hoon" → WhatsApp fallback.
   If the customer only said "yes" without a date, the call asks for the day & time.
4. **Call not picked / busy / failed / no clear answer** → WhatsApp right away:
   "Humne aapki site visit confirm karne ke liye call kiya tha, lekin call uth nahi paayi… Kya aap aa rahe hain?"
   with buttons **[Haan, confirm ✅] [Nahi / date badlo]**.
   * Haan → confirmed.  * Nahi → bot asks for a new date or when to follow up; the new date given in chat is
     saved as confirmed (no second call).
5. **Toggle OFF:** no calls at all. WhatsApp "Kya aap aa rahe hain? YES / NO" goes `hoursBefore` the visit.

Outside the 24-hour WhatsApp window a message can only go as an approved template — pick one on the
Visit confirmation page (variables {{1}} name · {{2}} project · {{3}} day · {{4}} time).

## 4. Reliability built in
* One call per visit (atomic claim — the instant trigger and the scheduler never double-call).
* Hang-up result lost? After 8 minutes the scheduler closes the call itself and sends the WhatsApp fallback.
* Gemini down → Groq → simple yes/no rules. ElevenLabs down → Plivo's own voice. The call never goes silent.
* Long silence → "Hello, kya aap sun pa rahe hain?" once, then a polite goodbye + WhatsApp.
* Minutes are metered per company (`usage.voiceMinutes`); price per minute from `config/pricing.js`.
