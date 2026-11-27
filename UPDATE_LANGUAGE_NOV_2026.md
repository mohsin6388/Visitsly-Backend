# Update — Conversation language (spec section E, 24 Nov 2026)

All language logic lives in `src/services/language/`:

| File | What it does |
|---|---|
| `languages.js` | The 13 supported languages, aliases in every script, WhatsApp template codes, voice codes |
| `detect.js` | Reads a message's language (script + word lists, no AI), explicit requests ("Hindi mein baat karo"), yes/no words in all languages |
| `decide.js` | The rules E0–E4 (pure function, fully unit-tested) |
| `messages.js` | Every backend-written customer message in all 13 languages |
| `localize.js` | `t()`, dates/times per language, template translation picker, translation of company-written text |
| `conversationLanguage.js` | Saves the decision on the conversation |

## Rules

- **E0** — first customer message in English (or unreadable: emoji, sticker, romanised Tamil…) →
  the system itself sends, once: *"Hi! I'm {bot}, your property assistant 😊 / Which language would you
  prefer to chat in?"* + the language list. Claimed atomically (`languagePromptedAt`), never sent twice,
  never sent later in a chat. The AI prompt no longer asks about language at all.
- **E1** — first message in any other supported language → no question; the AI replies in that language
  and script straight away.
- **E2** — a chosen language is saved (`language`, `languageSource: 'selected'`) and locked.
- **E3** — explicit requests switch immediately and are saved: Roman ("Hindi mein baat karo",
  "Speak in English", "Urdu mein jawab do") and native script ("தமிழில் பேசுங்கள்", "اردو میں بات کریں").
  Regional requests typed in Roman letters work too ("Marathi madhe bola", "Gujarati ma vaat karo",
  "Punjabi vich gal karo", "Tamil la pesunga", "Telugu lo matladandi"…).
  Negations are ignored ("I don't understand Hindi"). The model also reports `language_change_request`;
  it is only trusted when the customer really named that language.
- **E4** — with no explicit choice (`languageSource: 'detected'`), the chat switches only after **two
  consecutive real messages** in another language. "ok / yes / thanks / 👍" and one-word messages never
  count. A chosen language is never overridden by messages in another language.
- **E5** — Hindi (Devanagari) and Hinglish (Roman) are separate everywhere. The saved language is used by:
  AI replies, visit confirmation (text + buttons), YES/NO acknowledgements, call-outcome messages,
  call-back confirmations, "not reached" / "call dropped" messages, follow-ups and re-engagement,
  AI follow-up drafts, media captions, "AI busy" hold message, STOP acknowledgement, opening message,
  and AI call opening lines.

Old chats: a saved language without a source is treated as chosen (it was locked before), so nothing
changes for them.

## WhatsApp templates

Create the same template name in each language you need (Template Manager now lists all 13 languages).
When the 24-hour window is closed, visit confirmation, follow-up, post-call and opening templates go out in
the customer's language if an approved translation exists, otherwise in the configured language (one
retry if Meta rejects the translation).

## Calls

The call language follows the saved chat language (`VOICE_LANGUAGES`, default `hi,en,ar`; Hinglish is
spoken Hindi). A customer whose language is not enabled is **not** called in another language:
visit confirmations and visit-day reminders go on WhatsApp in their language, lead calls show a clear
reason. A saved language is never asked again on the call (the Hindi "Hindi या English?" opening is
used only when no language is known). Arabic calls now open in Arabic (were English).

## Inbox

Side panel → **Chat language**: shows the language and how it was decided; the team can set it
(`PATCH /api/conversations/:id/language { language | null }`, saved as `agent`, locked) or return it
to automatic. Arabic / Urdu messages display right-to-left.

## Test

`npm run test:language` (19 checks) — plus the existing smoke tests.

## Site visit booking in every language (fix)

Bug: when the AI model did not flag the visit itself, the backup check only understood Hinglish/English
("kal subah 11 baje"). In Hindi (Devanagari), Urdu, Arabic, Bangla, Marathi, Gujarati, Punjabi, Tamil,
Telugu, Kannada and Malayalam chats the customer's "tomorrow 11 o'clock" was not read, so **no visit was saved**:
nothing in Site Visits, no confirmation call/WhatsApp, no owner alert.

Fixed in `src/services/ai/visitInference.js`:
- today / tomorrow / day after, weekday names, morning/afternoon/evening and "N o'clock" in all 13
  languages (native digits like ১১ / ١١ / ११ too).
- the bot's "which day / time?" question and the word "visit" recognised in every language;
  a customer who asks for a visit on a day themselves ("நாளை சைட் விசிட்") is booked too.
- "no / not now / cancel" in every language never books; Hindi tag "ना" is not a no.
- "shaam 7 baje" is now 19:00 (was 07:00).
- The AI prompt asks the visit questions in the chat language and must always fill
  proposedDate/proposedTime when a day was given.

Tests: `npm run test:language` (21 checks) includes all 13 languages and a full chat run where the model
forgets the flag and the visit is still saved.
