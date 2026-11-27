/**
 * Safety net for site-visit booking in the WhatsApp chat — works in every chat language.
 *
 * The LLM is supposed to set wantsSiteVisit / proposedDate / proposedTime when the customer agrees to a
 * visit. When it forgets (free-tier model, 429/503 fallbacks, flash-lite…) the customer hears "our team will
 * call you to confirm" but no visit is ever created, so it never shows in Site Visits and no confirmation
 * call goes out.
 *
 * This module decides — from plain text, no LLM — whether the customer just answered the bot's
 * "which day / time?" (or "would you like a site visit?") question, or asked for a visit on a day
 * themselves, and extracts the day and time. Supported: English, Hinglish, Hindi, Urdu, Arabic,
 * Bangla, Marathi, Gujarati, Punjabi, Tamil, Telugu, Kannada, Malayalam.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const L = "[\\p{L}\\p{M}]";

/**
 * Builds one regex from a word list. Each entry matches at a word start; entries ending in
 * "*" may carry a suffix (Tamil நாளைக்கு, Malayalam ഉച്ചയ്ക്ക്…), others must end at a word end.
 */
function words(list) {
  const parts = list
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const stem = w.endsWith("*");
      const body = (stem ? w.slice(0, -1) : w).normalize("NFC").replace(/_/g, " ").replace(/[.?+()[\]{}|^$\\]/g, "\\$&");
      return stem ? body : `${body}(?!${L})`;
    });
  return new RegExp(`(?<!${L})(?:${parts.join("|")})`, "iu");
}

/** Native digits (Devanagari, Bengali, Gurmukhi, Gujarati, Tamil, Telugu, Kannada, Malayalam, Arabic-Indic) → 0-9. */
const DIGIT_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0660, 0x06f0];
function normalizeDigits(text) {
  return String(text || "").replace(/[०-९০-৯੦-੯૦-૯௦-௯౦-౯೦-೯൦-൯٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    return String(code - zero);
  });
}

function pad(n) { return String(n).padStart(2, "0"); }

/** IST calendar date (YYYY-MM-DD) `offset` days from today. */
function istDate(offset = 0, now = Date.now()) {
  const d = new Date(now + 330 * 60000 + offset * 86400000);
  return d.toISOString().slice(0, 10);
}
function istWeekday(now = Date.now()) {
  return new Date(now + 330 * 60000).getUTCDay();
}

/* ------------------------------------------------------------------ */
/* Day words — checked in this order (day after tomorrow before tomorrow) */
/* ------------------------------------------------------------------ */
const DAY_AFTER = words(`
  parso parson parsu parsoon day_after_tomorrow porshu porshudin parmdivse param parva parvaa
  ellundi naadiddu nadiddu mattannal
  परसों परसो परवा پرسوں بعد_بكرة بعد_بكره بعد_بكرا بعد_غد بعد_غدا
  পরশু পরশুদিন પરમદિવસે પરમ_દિવસે પરમ ਪਰਸੋਂ ਪਰਸੋਂ
  நாளை_மறுநாள்* நாளைமறுநாள்* ఎల్లుండి* ನಾಡಿದ್ದು* മറ്റന്നാൾ*
`);
const TOMORROW = words(`
  kal kl kaal tomorrow tmrw tmr tommorow tomorow tomarrow udya udyaa kale kaale kalle
  naalai* nalai* nalaiku repu naale* bukra bukrah
  कल उद्या کل کل_کو بكرة بكره بكرا غدا غداً الغد باكر
  কাল কালকে আগামীকাল কালকে કાલે કાલ ਕੱਲ੍ਹ ਕੱਲ ਕਲ੍ਹ
  நாளை* రేపు* ನಾಳೆ* നാളെ*
`);
const TODAY = words(`
  aaj aj today aaje tonight ivattu indru innaiku eeroju ivala innu
  आज آج اليوم الليلة আজ আজকে આજે આજ ਅੱਜ
  இன்று* இன்னைக்கு* ఈరోజు* ఇవాళ* ಇಂದು* ಇವತ್ತು* ഇന്ന്*
`);

/** Weekday names in every language (Roman + native script). Index = JS getDay(). */
const WEEKDAYS = [
  words(`sunday sun ravivar ravivaar raviwar itwar itvaar etwar aitvar aitwar robibar
    रविवार इतवार اتوار الأحد الاحد احد রবিবার રવિવાર ਐਤਵਾਰ ஞாயிற* ஞாயிறு* ఆదివారం* ಭಾನುವಾರ* ഞായറാഴ്ച* ഞായർ*`),
  words(`monday mon somvar somvaar somwar shombar
    सोमवार پیر_کو سوموار الإثنين الاثنين اثنين সোমবার સોમવાર ਸੋਮਵਾਰ திங்கட்கிழமை* திங்கள்கிழமை* సోమవారం* ಸೋಮವಾರ* തിങ്കളാഴ്ച* തിങ്കൾ*`),
  words(`tuesday tue tues mangalvar mangalvaar mangalwar mongolbar
    मंगलवार मंगळवार منگل الثلاثاء ثلاثاء মঙ্গলবার મંગળવાર ਮੰਗਲਵਾਰ செவ்வாய்க்கிழமை* செவ்வாய்* మంగళవారం* ಮಂಗಳವಾರ* ചൊവ്വാഴ്ച* ചൊവ്വ*`),
  words(`wednesday wed budhvar budhvaar budhwar budhbar
    बुधवार بدھ الأربعاء الاربعاء اربعاء বুধবার બુધવાર ਬੁੱਧਵਾਰ ਬੁਧਵਾਰ புதன்கிழமை* புதன்* బుధవారం* ಬುಧವಾರ* ബുധനാഴ്ച* ബുധൻ*`),
  words(`thursday thu thur thurs guruvar guruvaar guruwar veervar veerwar brihaspativar brihospotibar
    गुरुवार बृहस्पतिवार جمعرات الخميس خميس বৃহস্পতিবার ગુરુવાર ਵੀਰਵਾਰ வியாழக்கிழமை* வியாழன்* గురువారం* ಗುರುವಾರ* വ്യാഴാഴ്ച* വ്യാഴം*`),
  words(`friday fri shukravar shukravaar shukrawar jumma jumah shukrobar
    शुक्रवार جمعہ جمعے الجمعة جمعة শুক্রবার શુક્રવાર ਸ਼ੁੱਕਰਵਾਰ ਸ਼ੁਕਰਵਾਰ வெள்ளிக்கிழமை* வெள்ளி* శుక్రవారం* ಶುಕ್ರವಾರ* വെള്ളിയാഴ്ച* വെള്ളി*`),
  words(`saturday sat shanivar shanivaar shaniwar shonibar
    शनिवार ہفتے_کو ہفتہ_کو سنیچر السبت سبت শনিবার શનિવાર ਸ਼ਨੀਵਾਰ சனிக்கிழமை* சனி* శనివారం* ಶನಿವಾರ* ശനിയാഴ്ച* ശനി*`),
];

/* ------------------------------------------------------------------ */
/* Part of day                                                         */
/* ------------------------------------------------------------------ */
const MORNING = words(`
  subah subha subhah morning savere savare sakali sakaal* sokal* kaalai* kalai udayam poddhuna poddun beligge raavile ravile
  सुबह सकाळी सकाळ صبح الصباح صباحا صباحاً الصبح সকাল* સવારે સવાર ਸਵੇਰੇ ਸਵੇਰ
  காலை* ఉదయం* పొద్దున* ಬೆಳಿಗ್ಗೆ* ಬೆಳಗ್ಗೆ* രാവിലെ*
`);
const AFTERNOON = words(`
  dopahar dophar dupahar afternoon noon dupur* dupari bapore madhyam madhyanam madhyahna uchakku
  दोपहर दुपारी دوپہر الظهر ظهرا ظهراً দুপুর* બપોરે બપોર ਦੁਪਹਿਰ
  மதியம்* మధ్యాహ్నం* ಮಧ್ಯಾಹ್ನ* ഉച്ച*
`);
const EVENING = words(`
  shaam sham evening sanjh sondhya* bikel* sandhyakali saanje sanje maalai* sayantram vaikunneram vaikittu night raat
  शाम संध्याकाळी संध्याकाळ रात شام رات مساء مساءً المساء العصر الليل সন্ধ্যা* বিকেল* બપોર_પછી સાંજે સાંજ ਸ਼ਾਮ ਰਾਤ
  மாலை* சாயங்காலம்* సాయంత్రం* ಸಂಜೆ* വൈകുന്നേരം* വൈകിട്ട്*
`);

/* "11 baje", "11 बजे", "11 மணிக்கு", "11টায়", "الساعة 11", "11:30", "11 am" … */
const TIME_UNIT_AFTER = new RegExp("(?<!\\d)(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|a\\.m\\.|pm|p\\.m\\.|baje|bje|baj|o'?clock|बजे|बजकर|वाजता|वाजे|بجے|টায়|টার|টা|বাজে|વાગ્યે|વાગે|ਵਜੇ|மணிக்கு|மணி|గంటలకు|గంటకు|గంటల|ಗಂಟೆಗೆ|ಗಂಟೆ|മണിക്ക്|മണി)".normalize("NFC"), "iu");
const TIME_UNIT_BEFORE = /(?:الساعة|الساعه|ساعة|at)\s*(\d{1,2})(?:[:.](\d{2}))?/iu;
const TIME_CLOCK = /(?<![\d.])(\d{1,2}):(\d{2})(?!\d)/;

/** { date, time } picked out of a customer message (either may be null). */
function parseWhen(text, now = Date.now()) {
  const t = normalizeDigits(text).normalize("NFC").toLowerCase();
  let date = null;
  if (DAY_AFTER.test(t)) date = istDate(2, now);
  else if (TOMORROW.test(t)) date = istDate(1, now);
  else if (TODAY.test(t)) date = istDate(0, now);
  else {
    for (let dow = 0; dow < 7; dow += 1) {
      if (WEEKDAYS[dow].test(t)) {
        const diff = (dow - istWeekday(now) + 7) % 7 || 7;
        date = istDate(diff, now);
        break;
      }
    }
  }

  const morning = MORNING.test(t);
  const afternoon = !morning && AFTERNOON.test(t);
  const evening = !morning && !afternoon && EVENING.test(t);
  let time = null;
  const m = TIME_UNIT_AFTER.exec(t) || TIME_UNIT_BEFORE.exec(t) || TIME_CLOCK.exec(t);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const unit = String(m[3] || "").replace(/\./g, "");
    if (h <= 23 && min <= 59) {
      if (unit === "pm" && h < 12) h += 12;
      else if (unit === "am" && h === 12) h = 0;
      else if (unit !== "am" && unit !== "pm" && h < 12) {
        // "shaam 7 baje" → 19:00, "dopahar 2 baje" → 14:00, plain "5 baje" → 17:00 (nobody visits at 5 am).
        if (evening || (afternoon && h <= 6)) h += 12;
        else if (!morning && h >= 1 && h <= 6) h += 12;
      }
      time = `${pad(h)}:${pad(min)}`;
    }
  } else if (morning) time = "11:00";
  else if (afternoon) time = "14:00";
  else if (evening) time = "17:00";
  return { date, time };
}

/* ------------------------------------------------------------------ */
/* What the bot asked / what the customer said                          */
/* ------------------------------------------------------------------ */
// The bot asked for a day / time (in the chat language).
const ASKED_WHEN_LATIN = /(kaunsa din|kaun sa din|konsa din|kis din|kab aa|which day|what day|what time|which time|din aur time|day and time|date aur time|date and time|kitne baje|kab tak|convenient time|suit(s)? you)/i;
const ASKED_WHEN_NATIVE = words(`
  कौन_सा_दिन* कौनसा_दिन* किस_दिन* कितने_बजे* दिन_और_समय* समय*
  کون_سا_دن* کس_دن* کب* وقت* کتنے_بجے*
  أي_يوم* اي_يوم* متى* الوقت* وقت* يناسبك* موعد*
  কোন_দিন* কবে* কখন* সময়*
  कोणता_दिवस* कोणत्या_दिवशी* कधी* वेळ*
  કયો_દિવસ* કયા_દિવસે* ક્યારે* સમય*
  ਕਿਹੜਾ_ਦਿਨ* ਕਿਹੜੇ_ਦਿਨ* ਕਦੋਂ* ਸਮਾਂ* ਸਮੇਂ*
  எந்த_நாள்* எந்த_நாளில்* எப்போது* நேரம்*
  ఏ_రోజు* ఎప్పుడు* సమయం* సమయానికి*
  ಯಾವ_ದಿನ* ಯಾವಾಗ* ಸಮಯ*
  ഏത്_ദിവസ* എപ്പോൾ* സമയ*
`);
// "Site visit" in any language.
const VISIT_WORDS = words(`
  visit* site_dekh* property_dekh* ghar_dekh* flat_dekh* dekhne_aa* dekhne_aana*
  विज़िट* विजिट* साइट* देखने_आ* भेट* व्हिजिट* साईट*
  وزٹ* دورہ* دورے* سائٹ* دیکھنے_آ*
  زيارة* زياره* معاينة* معاينه* تزور* زيارتك*
  ভিজিট* পরিদর্শন* সাইট* দেখতে_আস*
  વિઝિટ* મુલાકાત* સાઇટ* જોવા_આવ*
  ਵਿਜ਼ਿਟ* ਵਿਜਿਟ* ਦੌਰਾ* ਸਾਈਟ* ਦੇਖਣ_ਆ*
  விசிட்* சைட்* பார்வையிட* பார்க்க_வர*
  విజిట్* సైట్* సందర్శ* చూడటానికి*
  ವಿಸಿಟ್* ಸೈಟ್* ಭೇಟಿ* ನೋಡಲು*
  വിസിറ്റ്* സൈറ്റ്* സന്ദർശ* കാണാൻ*
`);
// A clear "no / not now / cancel" in any language.
const NEGATIVE_LATIN = /\b(nahi|nahin|nhi|no|not now|not interested|cancel|mat|busy|later|baad mein|baad me|nako|nathi|illa|vendam|ledu|vaddu|beda|venda)\b/i;
const NEGATIVE_NATIVE = words(`
  नहीं नही मत नाही नको بعد_میں نہیں لا مش ليس لاحقا لاحقاً إلغاء الغاء
  না নাহ બાદમાં નહીં નથી ਨਹੀਂ
  இல்லை* வேண்டாம்* లేదు* వద్దు* ಇಲ್ಲ* ಬೇಡ* ഇല്ല* വേണ്ട*
`);
const QUESTION = /[?？؟]/;

function isNegative(text) {
  const t = String(text || "").normalize("NFC");
  return NEGATIVE_LATIN.test(t) || NEGATIVE_NATIVE.test(t);
}
function mentionsVisit(text) {
  return VISIT_WORDS.test(String(text || "").normalize("NFC"));
}
function askedWhen(text) {
  const t = String(text || "").normalize("NFC");
  return ASKED_WHEN_LATIN.test(t) || (QUESTION.test(t) && ASKED_WHEN_NATIVE.test(t));
}
function invitedToVisit(text) {
  const t = String(text || "");
  return QUESTION.test(t) && mentionsVisit(t);
}

/**
 * @param {object} p
 * @param {Array}  p.recentMessages  oldest → newest (Message docs, before the AI reply is saved)
 * @param {string} p.currentMessage  the customer's latest text
 * @param {string} p.messageType     WhatsApp message type
 * @returns {null | {date: string|null, time: string|null, reason: string}}
 */
function inferVisitFromChat({ recentMessages = [], currentMessage = "", messageType = "text" } = {}) {
  if (["image", "video", "audio", "document", "sticker"].includes(messageType)) return null;
  const text = String(currentMessage || "").trim();
  if (!text || text.length > 200 || isNegative(text)) return null;

  const { date, time } = parseWhen(text);
  if (!date) return null; // a visit is booked only with a real day — a bare "haan" moves to the day/time question

  // 1) The customer asked for a visit on a day themselves ("நாளை சைட் விசிட்", "visit kal karenge").
  if (mentionsVisit(text)) return { date, time, reason: "asked_visit_with_day" };

  // 2) The bot asked "which day / time?" (or invited them for a visit) and the customer named a day.
  const prev = [...recentMessages].reverse().find((m) => m.direction === "outbound");
  const prevText = String(prev?.text || "");
  if (prevText && (askedWhen(prevText) || invitedToVisit(prevText))) {
    return { date, time, reason: "answered_day_time" };
  }
  return null;
}

module.exports = { inferVisitFromChat, parseWhen, mentionsVisit, isNegative, normalizeDigits };
