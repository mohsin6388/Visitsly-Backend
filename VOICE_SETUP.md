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
* Minutes are metered per company (`usage.voiceMinutes`). Calls stop when the plan's monthly minutes and the recharged minutes (`Organization.voicePrepaidUsed` tracks pack use) are finished; recharge price per minute from `config/pricing.js` (Growth and above).

---

## Real-time engine (human-like calls) — November 2026

The classic engine waited for the customer to finish, sent the speech to Plivo's
recogniser, then the AI, then made an MP3 for Plivo to download. That added up to 3–5 s
of silence per turn, and the customer could not interrupt.

The real-time engine streams the call audio both ways over a WebSocket:

```
Customer ⇄ Plivo ⇄ wss://<api>/api/voice/stream/<call>/<token>
                       ├─► Deepgram Nova-3 (live speech-to-text, Hindi + English mixed)
                       ├─► Gemini (streamed, first sentence spoken while the rest is written)
                       └─► ElevenLabs Flash (streamed phone audio, μ-law 8 kHz) ──► Plivo
```

* Replies start about 1 second after the customer stops talking.
* The customer can interrupt: the agent stops speaking at once and listens.
* If the customer pauses and keeps talking, the half-made reply is dropped.
* The result (confirmed / new date / follow-up / not interested) is read from the
  transcript when the call ends and applied exactly as before (Site visits, Follow-ups,
  WhatsApp re-confirmation, lead notes, minutes billing — unchanged).

### Setup

1. Create a Deepgram account → API key → put it in `.env`:
   `DEEPGRAM_API_KEY=...` (ElevenLabs keys are already set).
2. `npm install` (adds the `ws` package) and `pm2 restart visitsly-backend`.
   The log should show: `[voice] Real-time call engine ON`.
3. **Nginx must allow WebSocket upgrades** for the stream path. Add this inside the
   `server { }` block of your API domain (above the general `location /`):

   ```nginx
   location /api/voice/stream/ {
       proxy_pass http://127.0.0.1:5000;      # your Node port
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 3600s;
       proxy_send_timeout 3600s;
       proxy_buffering off;
   }
   ```
   then `sudo nginx -t && sudo systemctl reload nginx`.
   (If you use Cloudflare, WebSockets must be enabled — they are by default.)
4. Make a test call from AI calling → Test call. In `pm2 logs` you should see
   `[rt] stream started`, `[rt] customer said …`, `[rt] agent started speaking {ms}`.

### Safety nets
* No `DEEPGRAM_API_KEY`, or `VOICE_ENGINE=classic` → the classic engine is used.
* If the live stream does not connect within `VOICE_STREAM_CONNECT_MS` (4 s), the call
  is moved to the classic engine automatically, so the customer never hears silence.
  The log then says `live audio stream did not connect` → check the nginx block above.
* If Gemini is down, the agent says a safe fixed line (same as before).

### Tuning (all optional)
| Setting | Default | Effect |
|---|---|---|
| `VOICE_ENDPOINTING_MS` | 350 | Silence that ends a sentence. Raise to 500 if the agent cuts customers off. |
| `VOICE_BARGE_IN_WORDS` | 2 | Words needed to interrupt the agent ("haan" alone does not). |
| `VOICE_SILENCE_MS` | 7000 | Wait before "Hello, can you hear me?" |
| `ELEVENLABS_STABILITY` / `ELEVENLABS_STYLE` / `ELEVENLABS_SPEED` | 0.45 / 0.15 / 1.0 | Voice expressiveness and pace. |
| `GEMINI_VOICE_MODELS` | gemini-2.5-flash-lite,… | Fastest model first. |

Test without real calls: `npm run test:voice` (simulated call: speaking, interruption, goodbye, hang-up).

### Lead calls (like the WhatsApp chat)
Calls to leads (Upload Data → call icon, Leads → AI calling, auto-call new leads) are **not**
visit-confirmation calls. The agent gets the same knowledge as the WhatsApp assistant:
the company's available properties (the lead's project first), the lead's profile and the
latest WhatsApp messages. It asks what they need, suggests matching properties, answers
from the facts and invites them for a site visit.

After the call:
* Visit agreed (day + time) → added to **Site visits**, confirmed by call, WhatsApp with the
  details, Google Calendar event, lead → Site visit. An existing upcoming visit is moved
  instead of creating a second one.
* Interested but not now / gave a date → **Follow-up**. Busy → call-back follow-up.
* Requirement (budget, location, BHK, project, timeline) → saved on the lead.

Test it: Visit confirmation → Settings → Test call → **Call type: Lead call**.
Do not set `VOICE_INPUT_MODE=dtmf` — that forces "press 1 / press 2" calls.
