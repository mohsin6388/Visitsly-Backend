# Update — WhatsApp AI + AI calling (21 Nov 2026)

## WhatsApp AI
- **No double reply**: right before sending, the AI checks whether the customer wrote again.
  If yes, that reply is dropped; the newest message's reply reads all unanswered messages together.
  No artificial delay anymore (`services/ai/replyGuard.js → hasNewerInbound`).
- **Bot-loop guard**: chatbot-like replies (menus, "didn't understand", auto-replies), more than
  5 messages in a minute, or the same text 3× while we kept answering → chat set to *AI paused*
  (`status: manual`) + owner notification. Resume it from the AI inbox.
- **Junk limit**: 3 junk messages in a row (emoji only, keyboard mash, abuse, repeats) → AI stays
  quiet until a real message comes.
- **Voice notes** are transcribed with Gemini and answered (`services/ai/voiceNote.js`).
- **Bot name / gender / default language / own instructions** per company:
  Settings → AI & business settings → *AI assistant* (+ "Improve my prompt").
  Core rules (only real property data, no lies, language lock, media rules, JSON) always win.
- **Language lock**: Hindi = Devanagari, Hinglish only when chosen, English/Bangla/Arabic stay as chosen.
- **Format**: lists / details / amenities go in a fixed WhatsApp bullet format (max 3 properties, max 6 amenities).
- **No fake projects**: prompt examples use placeholders (Project A, City X). Unknown city → "abhi wahan koi property nahi".
- **Sales approach**: handles hesitation and objections, one next step per reply, no fake urgency.
- **Visitsly/Monica pitch** only for your own company: set `VISITSLY_PITCH_ORG_IDS` (org id or owner user id).
- **Photos / brochure**: offered only when the property really has them; "haan / ok / bhejo" right
  after the offer sends that property's media (max 5 photos). "document" alone no longer sends a brochure.

## AI calling
- India and UAE are separate (`services/voice/callPolicy.js`): own number, hours, language.
  UAE stays off until `VOICE_UAE_ENABLED=true` + an `AE` number in `PLIVO_FROM_NUMBERS_JSON`.
- STOP / opted-out leads are never called (any kind of call).
- India DND check: AI calling → Settings → *Skip DND numbers* (your DND API URL with `{phone}` + key).
- Clear error reasons in the call list (DND, number busy, not picked up, wrong number, switched off, Plivo balance, STOP).
- After a lead call (`services/voice/postCall.js`):
  - "busy / call later" or keypad 2 → AI calls again at that time (next day if no time) + WhatsApp note;
  - not picked up → one retry after 2–3 h; still not reached → WhatsApp bot starts the chat;
  - interested but no visit, or call dropped → WhatsApp bot follows up using the call summary;
  - call summary is given to the WhatsApp AI so it doesn't ask again;
  - visit booked on the call → Site visits + WhatsApp confirmation (template when the 24 h window is closed).
- One calling batch = max 100 contacts. `VOICE_BULK_CONCURRENCY` can go up to 10.

## Follow-ups
- Follow-ups page warns when no follow-up template is set; the template picker is always visible in setup.

## Test
`node test/chat-and-calls.smoke.js`
