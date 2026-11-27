/**
 * Reads the language of a customer message — deterministic, no AI call.
 *
 *   detectLanguage(text)        → { language, confident, substantive, neutral, script }
 *   parseLanguageRequest(text)  → "Hindi" when the customer explicitly asks for /
 *                                 picks a language ("Hindi mein baat karo",
 *                                 "Speak in English", "Urdu mein jawab do",
 *                                 "தமிழில் பேசுங்கள்", just "Tamil"), else null
 *   mentionsLanguage(text, L)   → true when the message names language L
 *
 * Hindi (Devanagari) and Hinglish (Roman Hindi) are separate languages:
 * Devanagari Hindi → "Hindi", Hindi typed in Roman letters → "Hinglish".
 */
const { LANGUAGES, escapeRe } = require("./languages");

/* ------------------------------------------------------------------ */
/* Scripts                                                             */
/* ------------------------------------------------------------------ */
const SCRIPTS = [
  ["Devanagari", /[ऀ-ॿ꣠-ꣿ]/u],
  ["Bengali", /[ঀ-৿]/u],
  ["Gurmukhi", /[਀-੿]/u],
  ["Gujarati", /[઀-૿]/u],
  ["Tamil", /[஀-௿]/u],
  ["Telugu", /[ఀ-౿]/u],
  ["Kannada", /[ಀ-೿]/u],
  ["Malayalam", /[ഀ-ൿ]/u],
  ["Arabic", /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u],
  ["Latin", /[A-Za-zÀ-ɏ]/u],
];
const SCRIPT_LANGUAGE = {
  Bengali: "Bangla",
  Gurmukhi: "Punjabi",
  Gujarati: "Gujarati",
  Tamil: "Tamil",
  Telugu: "Telugu",
  Kannada: "Kannada",
  Malayalam: "Malayalam",
};

function scriptCounts(text) {
  const counts = {};
  let total = 0;
  for (const ch of String(text || "")) {
    if (!/[\p{L}\p{M}]/u.test(ch)) continue;
    for (const [name, re] of SCRIPTS) {
      if (re.test(ch)) {
        counts[name] = (counts[name] || 0) + 1;
        total += 1;
        break;
      }
    }
  }
  return { counts, total };
}

/** Main script of a message: a non-Latin script wins when it is a real part of it. */
function mainScript(text) {
  const { counts, total } = scriptCounts(text);
  if (!total) return null;
  let best = null;
  for (const [name, n] of Object.entries(counts)) {
    if (name === "Latin") continue;
    if (!best || n > counts[best]) best = name;
  }
  // "2 BHK flat चाहिए" — the Devanagari part decides even with English property words.
  if (best && counts[best] >= 2 && counts[best] / total >= 0.25) return best;
  if (counts.Latin) return "Latin";
  return best;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */
function stripNoise(text) {
  return String(text || "")
    // inbox labels for media ("[Photo] caption", "[Voice note] transcript")
    .replace(/^\s*\[(photo|video|voice note|document[^\]]*|sticker|location|contact|reaction|[a-z_]+ message)\]\s*/i, "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/[@#]\w+/g, " ");
}

function tokens(text) {
  return (stripNoise(text).toLowerCase().match(/[\p{L}\p{M}']+/gu) || []).map((t) => t.replace(/^'+|'+$/g, "")).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Word lists                                                          */
/* ------------------------------------------------------------------ */
const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

// Roman Hindi (Hinglish). Verbs/auxiliaries are strong signals.
const HINGLISH_STRONG = set(`
  hai hain hu hoon hun nahi nahin nhi nai kya kyu kyun kyon kaise kaisa kaisi kitna kitne kitni kab kahan kaha kidhar
  mujhe mujhko muje mera meri mere hume humko hamara hamari humara humari aap aapka aapki aapke aapko apka apki apke apko apne apna apni
  tum tumhara tumhari tumko chahiye chahie chaiye chahiye chahta chahti chahte karna karni karne karo kro karein kare karenge karunga karungi karta karti karte
  raha rahi rahe rha rhi rhe wala wali wale bhai bhaiya haan haanji hanji accha acha achha achchha theek thik thk bhejo bhejiye bhejna bhej batao bataiye bataye btao bataen
  dekhna dekhne dekho dikhao dikhaiye ghar makaan makan paisa paise abhi parso aaj subah shaam sham raat pehle phir fir sirf lekin aur bhi
  woh yeh yahan wahan koi kuch sab sabse bahut bohot bhot zyada jyada thoda sahi galat matlab samajh pata mein liye lie namaste namaskar shukriya
  dhanyavaad dhanyawad dhanyavad kripya krpya zaroor jaroor bilkul pakka chalega chalegi chalo milega milegi milenge dijiye kijiye lijiye rakho
  lena lene dena dene jana jaana aana aaunga aaungi aayenge aenge sakta sakte sakti paunga payenge hoga hogi honge tha thi gaya gayi gaye diya liya kiya
  bola bolo bolna boliye suniye suno socha soch samjha kal baje baat kijiye chahunga chahungi dikhana bataya
`);
// Short Hindi function words: weaker (they are short and could be typos).
const HINGLISH_WEAK = set("ka ki ke ko se ye wo ya bas mai");
const ENGLISH = set(`
  the is are am was were be been being i i'm im you you're your yours my mine me we our us it its it's this that these those
  what which who whom how when where why want wants wanted need needs looking look please pls plz can could would will shall should
  do does did done have has had for of in on at with about from and or but not no yes yeah yep hi hello hey thanks thank you
  send share tell give show know let there any some an a to if also just very much more less than then so because get got
  morning evening afternoon tomorrow today tonight week weekend interested available still sure great nice good fine okay
`);
// Romanised Bangla / Marathi / Gujarati / Punjabi / Tamil / Telugu / Kannada /
// Malayalam: NOT English. Seeing these makes a Latin message "unclear".
const ROMAN_OTHER = set(`
  ami tumi apni amar tomar apnar kemon achen acho ache korbo koro korun hobe nei keno kothay ekhon khub bhalo dada didi
  mala mi tumhi aahe ahe pahije kasa kuthe udya aata karaycha sanga nako chalel
  mane tame tamne che chhe kem cho majama joie joiye shu nathi aavjo kyare
  menu tusi tuhada tuhanu kiddan haige chahida chaida sanu oye paaji
  enakku vanakkam enna eppadi veedu venum venam illa irukku sollunga nandri ungal naan neenga
  naaku meeru ela undi ledu kavali cheppandi dhanyavadalu namaskaram illu avunu kaadu
  nanage neevu enu hege ide beku beda heli dhanyavadagalu namaskara
  enikku ningal entha enthu engane undu vendathu parayu nanni
`);

// Devanagari: Marathi vs Hindi.
const MARATHI_WORDS = set(`
  आहे आहेत आहोत आहेस नाही नाहीत मला तुम्ही तुम्हाला आम्ही आम्हाला माझा माझी माझे तुमचा तुमची तुमचे काय कसे कसा कशी
  आणि पण पाहिजे हवा हवी हवे होते होता करायचे करायचा बघायचे उद्या कधी किती इथे तिथे येथे साठी मध्ये सांगा द्या करा बोला
  नको चालेल कुठे आपण त्यांना त्याचा तिचा आता लवकर
`);
const HINDI_WORDS = set(`
  है हैं हूँ हूं नहीं मुझे मेरा मेरी मेरे आप आपको आपका आपकी आपके क्या कैसे और चाहिए में का की के को से था थी थे कल कहाँ कहां
  कितना कितने बताइए बताओ बताएं बताये करना करें कीजिए दीजिए भेजो भेजिए हाँ हां जी ठीक यह वह कोई कुछ अभी चाहता चाहती लेना देखना
`);

// Arabic script: Urdu vs Arabic.
const URDU_LETTERS = /[ٹڈڑںھہۂۃیےۓکگچپژ]/gu;
const ARABIC_LETTERS = /[ةيىك]/gu;
const URDU_WORDS = set("ہے ہیں میں کیا نہیں آپ کے کی کا کو سے اور مجھے چاہیے ہوں تھا تھی کب کہاں کتنا جی ہاں شکریہ ٹھیک بات کریں");
const ARABIC_WORDS = set("في من على هل أن ان ما انا أنا نعم شكرا شكراً مرحبا السلام أريد اريد شقة كم هذا هذه عندي عندك ممكن الله لو");

// Acknowledgements / fillers that never decide a language on their own.
const NEUTRAL = set(`
  ok okay okk okey k kk yes yeah yep yup ya no nope nah thanks thank thx ty tq hmm hm hmmm hmmmm ohk oh ah haan han ha haa ji jee
  nahi nhi na theek thik acha accha achha sure done fine great nice cool hi hii hiii hello helo hey bye good alright right welcome
  हाँ हां जी ठीक है नहीं धन्यवाद ओके हो नाही
  نعم لا شكرا شكراً تمام اوكي طيب جی ہاں نہیں شکریہ ٹھیک
  হ্যাঁ না ঠিক আছে ধন্যবাদ ওকে
  சரி ஆம் இல்லை நன்றி ஓகே
  సరే అవును లేదు ధన్యవాదాలు ఓకే
  ಸರಿ ಹೌದು ಇಲ್ಲ ಧನ್ಯವಾದ ಓಕೆ
  ശരി അതെ ഇല്ല നന്ദി ഓക്കെ
  હા ના બરાબર આભાર ઓકે
  ਹਾਂ ਨਹੀਂ ਠੀਕ ਧੰਨਵਾਦ ਓਕੇ
`);

function count(list, words, weight = 1) {
  let n = 0;
  for (const w of list) if (words.has(w)) n += weight;
  return n;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/**
 * @returns {{ language: string|null, confident: boolean, substantive: boolean, neutral: boolean, script: string|null }}
 *   language     best guess (null = can't tell, e.g. emoji / numbers / romanised Tamil)
 *   confident    the guess is reliable
 *   substantive  long enough to count as "a message in that language" (2+ real words)
 *   neutral      only "ok / yes / thanks / 👍"-style words — never decides a language
 */
function detectLanguage(text) {
  const words = tokens(text);
  const meaningful = words.filter((w) => !NEUTRAL.has(w));
  const neutral = meaningful.length === 0;
  const script = mainScript(stripNoise(text));
  const out = (language, confident = true) => ({
    language,
    confident: Boolean(language) && confident,
    substantive: Boolean(language) && confident && !neutral && meaningful.length >= 2,
    neutral,
    script,
  });
  if (!script || !words.length) return out(null, false);

  if (SCRIPT_LANGUAGE[script]) return out(SCRIPT_LANGUAGE[script]);

  if (script === "Devanagari") {
    const mr = count(words, MARATHI_WORDS);
    const hi = count(words, HINDI_WORDS);
    return out(mr > hi ? "Marathi" : "Hindi");
  }

  if (script === "Arabic") {
    const joined = words.join(" ");
    const urdu = (joined.match(URDU_LETTERS) || []).length + 3 * count(words, URDU_WORDS);
    const arabic = (joined.match(ARABIC_LETTERS) || []).length + 3 * count(words, ARABIC_WORDS);
    return out(urdu > arabic ? "Urdu" : "Arabic");
  }

  // Latin script: English vs Hinglish (Roman Hindi). Romanised other Indian
  // languages are left undecided rather than mistaken for English.
  const hindi = count(words, HINGLISH_STRONG, 1.5) + count(words, HINGLISH_WEAK, 0.5);
  const english = count(words, ENGLISH);
  const other = count(words, ROMAN_OTHER);
  if (other >= 1 && other >= hindi && other >= english) return out(null, false);
  if (hindi >= 1.5 && hindi >= english) return out("Hinglish");
  if (english >= 1) return out("English");
  if (hindi > 0) return out("Hinglish", false);
  // Only property words / names / numbers ("2bhk pune 50L"): English, but not sure.
  return out("English", false);
}

/* ------------------------------------------------------------------ */
/* Explicit language requests                                          */
/* ------------------------------------------------------------------ */

// Words that may surround a language name in a pure "pick / switch" message.
const REQUEST_FILLER = set(`
  please pls plz kindly in me mein main mai mei mujhse se only sirf bas language lang languages bhasha bhaasha bhasa preference prefer preferred
  chalega chalegi theek thik ok okay no yes better best is fine good would be will do i use ji sir mam madam yes haan han sahi rahega rahegi hai hoga
  ka ki ke mujhe aap aapse humse the a an my want need choose select option it its it's that this also too can could you we us let's lets
  karo kro karein karen kariye kijiye kijie bolo boliye baat bat reply chat talk speak write answer jawab likho likhiye samjhao samjhaiye
  continue switch change to into start with from now on onwards respond communicate converse pe par
  dena do dijiye kar karna karte sakte sakti sakta hain la lo il alli
  madhe madhye madhyem kara bola bolun bolen kotha koto te e ma maa vich wich ch vaat vat gal galbaat kariye karjo karo
  pesunga pesungal matladandi maatadi mathadi samsarikku samsarikkoo samsarikkuka parayu parayoo
  में मे बात करो करें कीजिए कीजिये बोलो बोलिए जवाब दो दीजिए दीजिये लिखो ठीक है हाँ जी कृपया सिर्फ़ सिर्फ भाषा पसंद चाहिए मुझे आप
  मध्ये बोला करा द्या कृपया हो
  میں بات کریں کرو جواب دیں دو بولیں ٹھیک ہے جی براہ کرم صرف زبان مجھے آپ
  باللغة لغة اللغة من فضلك تكلم تكلمي تحدث تحدثي رد كلمني ممكن ارجو أرجو لو سمحت فقط بس
  ভাষায় ভাষা কথা বলুন বলো বলেন লিখুন করুন দয়া করে ঠিক আছে শুধু
  பேசுங்கள் பேசு பேசவும் பதில் சொல்லுங்கள் தயவுசெய்து மொழி மட்டும்
  మాట్లాడండి మాట్లాడు చెప్పండి దయచేసి భాష మాత్రమే లో
  ಮಾತನಾಡಿ ಮಾತಾಡಿ ಹೇಳಿ ದಯವಿಟ್ಟು ಭಾಷೆ ಮಾತ್ರ
  സംസാരിക്കൂ സംസാരിക്കുക പറയൂ ദയവായി ഭാഷ മാത്രം
  વાત કરો બોલો કૃપા કરીને જવાબ ભાષા ફક્ત
  ਗੱਲ ਕਰੋ ਬੋਲੋ ਜਵਾਬ ਦਿਓ ਕਿਰਪਾ ਕਰਕੇ ਭਾਸ਼ਾ ਸਿਰਫ਼ ਵਿੱਚ
`);

// Verbs that turn "<language>" into a request when they sit next to it.
const REQUEST_VERB = set(`
  speak talk reply respond chat write answer continue switch change communicate converse use
  baat bat bolo boliye bol bolna jawab likho likhiye samjhao samjhaiye
  bola bolun bolen kotha vaat vat gal galbaat samsarikkuka
  pesunga pesungal pesu matladandi matladu maatladi maatadi mathadi samsarikku samsarikkoo parayu parayoo
  बात बोलो बोलिए बोल जवाब लिखो लिखिए समझाओ समझाइए बोला
  بات بولیں بولو جواب لکھیں تكلم تكلمي تحدث تحدثي رد كلمني اكتب
  কথা বলুন বলো লিখুন উত্তর
  பேசுங்கள் பேசு பேசவும் பதில் எழுதுங்கள்
  మాట్లాడండి మాట్లాడు సమాధానం రాయండి
  ಮಾತನಾಡಿ ಮಾತಾಡಿ ಉತ್ತರ ಬರೆಯಿರಿ
  സംസാരിക്കൂ സംസാരിക്കുക മറുപടി എഴുതൂ
  વાત બોલો જવાબ લખો
  ਗੱਲ ਬੋਲੋ ਜਵਾਬ ਲਿਖੋ
`);

// Clear negations near a language name ("I don't understand Hindi", "Hindi nahi aati").
const NEGATION = set(`
  not dont don't doesnt doesn't cannot can't cant nahi nahin nhi mat without never nor
  नहीं नही मत नाही नको نہیں نهیں ليس مش নয় இல்லை வேண்டாம் లేదు వద్దు ಇಲ್ಲ ಬೇಡ ഇല്ല വേണ്ട નહીં ਨਹੀਂ
`);
// Short "no" words count only right before the name ("no Hindi"), never across
// punctuation ("No, Hindi please" is a choice of Hindi) or as a tag ("Hindi mein bolo na").
const SOFT_NEGATION_BEFORE = /(?:^|[^\p{L}\p{M}])(no|na|ना|لا|না|ના|ਨਾ)\s+$/iu;
const NEGATION_PHRASE = /\b(do not|does not|did not|not able|unable to)\b/i;

// Aliases → matchers. Non-Latin names may carry a case ending
// ("தமிழில்", "తెలుగులో", "ಕನ್ನಡದಲ್ಲಿ", "বাংলায়", "മലയാളത്തിൽ").
const MATCHERS = LANGUAGES.map((l) => ({
  name: l.name,
  patterns: l.aliases.map((alias) => {
    const latin = /^[a-z\s-]+$/i.test(alias);
    if (latin) return new RegExp(`(^|[^\\p{L}\\p{M}])(${escapeRe(alias).replace(/\\?[\s-]+/g, "[\\s-]+")})(?![\\p{L}\\p{M}])`, "giu");
    const stem = alias.replace(/[्্੍્்్್്ംാ]$/u, "");
    return new RegExp(`(^|[^\\p{L}\\p{M}])(${escapeRe(stem)}[\\p{L}\\p{M}]*)`, "giu");
  }),
}));

/** Every language named in the text with its position. Longer names win ("Roman Hindi" over "Hindi"). */
function languageMentions(text) {
  const t = String(text || "");
  const found = [];
  for (const m of MATCHERS) {
    for (const re of m.patterns) {
      re.lastIndex = 0;
      let hit;
      while ((hit = re.exec(t))) {
        const start = hit.index + hit[1].length;
        found.push({ language: m.name, start, end: start + hit[2].length, word: hit[2] });
        if (re.lastIndex === hit.index) re.lastIndex += 1;
      }
    }
  }
  found.sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept = [];
  for (const f of found) {
    if (kept.some((k) => f.start < k.end && f.end > k.start)) continue;
    kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function mentionsLanguage(text, language) {
  return languageMentions(text).some((m) => m.language === language);
}

// Words next to a language name, inside the same clause only
// ("Hindi nahi aati, English mein bolo" → "nahi" belongs to Hindi, not English).
const CLAUSE_END = /[,.;!?\n،؛؟।॥]/u;
function wordsAround(text, mention, before = 3, after = 3) {
  const t = String(text);
  const leftText = t.slice(0, mention.start);
  let cut = -1;
  for (let i = leftText.length - 1; i >= 0; i -= 1) if (CLAUSE_END.test(leftText[i])) { cut = i; break; }
  const rightText = t.slice(mention.end);
  let stop = rightText.length;
  for (let i = 0; i < rightText.length; i += 1) if (CLAUSE_END.test(rightText[i])) { stop = i; break; }
  const left = tokens(leftText.slice(cut + 1)).slice(-before);
  const right = tokens(rightText.slice(0, stop)).slice(0, after);
  return { left, right };
}

function negated(text, mention) {
  const { left, right } = wordsAround(text, mention, 3, 3);
  if (left.some((w) => NEGATION.has(w)) || right.some((w) => NEGATION.has(w))) return true;
  const before = String(text).slice(Math.max(0, mention.start - 25), mention.start);
  return NEGATION_PHRASE.test(before) || SOFT_NEGATION_BEFORE.test(before);
}

/**
 * The language the customer explicitly asks for / picks in this message, or null.
 * Pure "pick" messages ("Hindi", "English please", "Hindi mein baat karo",
 * "Speak in English", "Urdu mein jawab do") and requests inside longer
 * messages ("…please reply in Tamil") both count. Mentions that are negated
 * ("I don't understand Hindi") are ignored; two different requested
 * languages ("Hindi or English") are not a choice.
 */
function parseLanguageRequest(text) {
  const raw = String(text || "");
  if (!raw.trim() || raw.length > 600) return null;
  const mentions = languageMentions(raw);
  if (!mentions.length) return null;

  const positive = mentions.filter((m) => !negated(raw, m));
  if (!positive.length) return null;

  // 1) The whole message is just the language (+ filler words).
  let rest = raw;
  for (const m of [...mentions].sort((a, b) => b.start - a.start)) rest = rest.slice(0, m.start) + " " + rest.slice(m.end);
  const leftover = tokens(rest).filter((w) => !REQUEST_FILLER.has(w) && !NEGATION.has(w));
  const distinct = [...new Set(positive.map((m) => m.language))];
  if (leftover.length === 0 && distinct.length === 1) return distinct[0];

  // 2) A request verb right next to the language name.
  const requested = positive.filter((m) => {
    const { left, right } = wordsAround(raw, m, 4, 4);
    return left.some((w) => REQUEST_VERB.has(w)) || right.some((w) => REQUEST_VERB.has(w));
  });
  const choice = [...new Set(requested.map((m) => m.language))];
  return choice.length === 1 ? choice[0] : null;
}

/* ------------------------------------------------------------------ */
/* Yes / no words (visit confirmation, media offers) — all languages    */
/* ------------------------------------------------------------------ */
const YES_WORDS = set(`
  yes yep yup yeah y ok okay k sure confirm confirmed done haan han haa ha hanji ji pakka theek thik bilkul zaroor
  हाँ हां जी ठीक बिल्कुल ज़रूर जरूर पक्का हो होय
  ہاں جی ٹھیک بالکل ضرور نعم أكيد اكيد تمام اوكي موافق
  হ্যাঁ হাঁ ঠিক আচ্ছা অবশ্যই
  ஆம் சரி கண்டிப்பாக
  అవును సరే తప్పకుండా
  ಹೌದು ಸರಿ ಖಂಡಿತ
  അതെ ശരി തീർച്ചയായും
  હા બરાબર ચોક્કસ
  ਹਾਂ ਠੀਕ ਜ਼ਰੂਰ
`);
const NO_WORDS = set(`
  no nope nah n cancel nahi nahin nhi na
  नहीं नही ना नाही नको
  نہیں نہ لا
  না নাহ
  இல்லை வேண்டாம்
  లేదు వద్దు కాదు
  ಇಲ್ಲ ಬೇಡ
  ഇല്ല വേണ്ട
  ના નહીં
  ਨਹੀਂ ਨਾ
`);

function firstWord(text) {
  return tokens(text)[0] || "";
}

/** Short reply that starts with a yes word in any supported language. */
function startsWithYes(text) {
  return YES_WORDS.has(firstWord(text)) || /^\s*(👍|✅|👌)/u.test(String(text || ""));
}

/** Short reply that starts with a no word in any supported language. */
function startsWithNo(text) {
  return NO_WORDS.has(firstWord(text));
}

module.exports = {
  detectLanguage,
  parseLanguageRequest,
  languageMentions,
  mentionsLanguage,
  mainScript,
  tokens,
  startsWithYes,
  startsWithNo,
  YES_WORDS,
  NO_WORDS,
};
