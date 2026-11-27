/**
 * The languages a customer can chat in, and everything the rest of the code
 * needs to know about each one.
 *
 * A conversation stores the canonical `name` ("Hindi", "Hinglish", "Tamil"…)
 * in `conversation.language`. Hindi (Devanagari) and Hinglish (Roman Hindi)
 * are two separate languages everywhere — chat, WhatsApp messages, templates
 * and calls.
 *
 *   locale     Intl locale used for dates / times in that language
 *   waCodes    Meta WhatsApp template language codes that are written in this
 *              language (first = preferred). Hinglish has none of its own: a
 *              Devanagari "hi" template is NOT Hinglish.
 *   voice      Voice-call language code (config/voiceAgents.js). Hinglish is
 *              spoken Hindi, so it shares "hi".
 *   aliases    Ways a customer may name the language (any script), lower-case.
 */
const LANGUAGES = [
  {
    name: "English", label: "English", native: "English", script: "Latin", rtl: false,
    locale: "en-IN", waCodes: ["en", "en_US", "en_GB", "en_IN"], voice: "en",
    aliases: ["english", "eng", "inglish", "angrezi", "angreji", "angrezi", "अंग्रेज़ी", "अंग्रेजी", "انگریزی", "الإنجليزية", "الانجليزية", "انجليزي", "إنجليزي", "ইংরেজি", "इंग्रजी", "અંગ્રેજી", "ਅੰਗਰੇਜ਼ੀ", "ਅੰਗਰੇਜ਼ੀ", "ஆங்கிலம்", "ఇంగ్లీష్", "ఆంగ్లం", "ಇಂಗ್ಲಿಷ್", "ಇಂಗ್ಲೀಷ್", "ഇംഗ്ലീഷ്"],
  },
  {
    name: "Hindi", label: "Hindi", native: "हिंदी", script: "Devanagari", rtl: false,
    locale: "hi-IN", waCodes: ["hi", "hi_IN"], voice: "hi",
    aliases: ["hindi", "हिंदी", "हिन्दी", "ہندی", "هندي", "الهندية", "হিন্দি", "हिंदी", "હિન્દી", "હિંદી", "ਹਿੰਦੀ", "ஹிந்தி", "இந்தி", "హిందీ", "ಹಿಂದಿ", "ഹിന്ദി"],
  },
  {
    name: "Hinglish", label: "Hinglish (Roman Hindi)", native: "Hinglish", script: "Latin", rtl: false,
    locale: "en-IN", waCodes: [], voice: "hi",
    aliases: ["hinglish", "roman hindi", "hindi in english", "hindi english", "hindi-english", "हिंग्लिश"],
  },
  {
    name: "Urdu", label: "Urdu", native: "اردو", script: "Arabic", rtl: true,
    locale: "ur-IN", waCodes: ["ur"], voice: "ur",
    aliases: ["urdu", "اردو", "उर्दू", "উর্দু", "ઉર્દૂ", "ਉਰਦੂ", "உருது", "ఉర్దూ", "ಉರ್ದು", "ഉറുദു", "الأردية", "الاردية", "أردو"],
  },
  {
    name: "Arabic", label: "Arabic", native: "العربية", script: "Arabic", rtl: true,
    locale: "ar-AE", waCodes: ["ar", "ar_EG"], voice: "ar",
    aliases: ["arabic", "arbi", "arabi", "عربي", "عربى", "العربية", "العربي", "بالعربي", "بالعربية", "عربی", "अरबी", "আরবি", "અરબી", "ਅਰਬੀ", "அரபு", "అరబిక్", "ಅರೇಬಿಕ್", "അറബി"],
  },
  {
    name: "Bangla", label: "Bangla", native: "বাংলা", script: "Bengali", rtl: false,
    locale: "bn-IN", waCodes: ["bn"], voice: "bn",
    aliases: ["bangla", "bengali", "bangali", "bongali", "বাংলা", "বাঙালি", "बंगाली", "बांग्ला", "बंगला", "بنگالی", "بنغالي", "البنغالية", "બંગાળી", "ਬੰਗਾਲੀ", "வங்காளம்", "బెంగాలీ", "ಬಂಗಾಳಿ", "ബംഗാളി"],
  },
  {
    name: "Marathi", label: "Marathi", native: "मराठी", script: "Devanagari", rtl: false,
    locale: "mr-IN", waCodes: ["mr"], voice: "mr",
    aliases: ["marathi", "मराठी", "مراٹھی", "মারাঠি", "મરાઠી", "ਮਰਾਠੀ", "மராத்தி", "మరాఠీ", "ಮರಾಠಿ", "മറാഠി"],
  },
  {
    name: "Gujarati", label: "Gujarati", native: "ગુજરાતી", script: "Gujarati", rtl: false,
    locale: "gu-IN", waCodes: ["gu"], voice: "gu",
    aliases: ["gujarati", "gujrati", "gujarathi", "ગુજરાતી", "गुजराती", "گجراتی", "গুজরাটি", "ਗੁਜਰਾਤੀ", "குஜராத்தி", "గుజరాతీ", "ಗುಜರಾತಿ", "ഗുജറാത്തി"],
  },
  {
    name: "Punjabi", label: "Punjabi", native: "ਪੰਜਾਬੀ", script: "Gurmukhi", rtl: false,
    locale: "pa-IN", waCodes: ["pa"], voice: "pa",
    aliases: ["punjabi", "panjabi", "ਪੰਜਾਬੀ", "पंजाबी", "پنجابی", "পাঞ্জাবি", "પંજાબી", "பஞ்சாபி", "పంజాబీ", "ಪಂಜಾಬಿ", "പഞ്ചാബി"],
  },
  {
    name: "Tamil", label: "Tamil", native: "தமிழ்", script: "Tamil", rtl: false,
    locale: "ta-IN", waCodes: ["ta"], voice: "ta",
    aliases: ["tamil", "thamizh", "tamizh", "தமிழ்", "तमिल", "تمل", "তামিল", "તમિલ", "ਤਮਿਲ", "తమిళం", "తమిళ్", "ತಮಿಳು", "തമിഴ്"],
  },
  {
    name: "Telugu", label: "Telugu", native: "తెలుగు", script: "Telugu", rtl: false,
    locale: "te-IN", waCodes: ["te"], voice: "te",
    aliases: ["telugu", "telgu", "తెలుగు", "तेलुगु", "تیلگو", "তেলুগু", "તેલુગુ", "ਤੇਲਗੂ", "தெலுங்கு", "ತೆಲುಗು", "തെലുങ്ക്"],
  },
  {
    name: "Kannada", label: "Kannada", native: "ಕನ್ನಡ", script: "Kannada", rtl: false,
    locale: "kn-IN", waCodes: ["kn"], voice: "kn",
    aliases: ["kannada", "kannad", "kanada", "ಕನ್ನಡ", "कन्नड़", "कन्नड", "کنڑ", "কন্নড়", "કન્નડ", "ਕੰਨੜ", "கன்னடம்", "కన్నడ", "കന്നഡ"],
  },
  {
    name: "Malayalam", label: "Malayalam", native: "മലയാളം", script: "Malayalam", rtl: false,
    locale: "ml-IN", waCodes: ["ml"], voice: "ml",
    aliases: ["malayalam", "malyalam", "മലയാളം", "मलयालम", "ملیالم", "মালায়ালম", "મલયાલમ", "ਮਲਿਆਲਮ", "மலையாளம்", "మలయాళం", "ಮಲಯಾಳಂ"],
  },
];

const BY_NAME = new Map(LANGUAGES.map((l) => [l.name.toLowerCase(), l]));
const NAMES = LANGUAGES.map((l) => l.name);

/** How a saved language was decided. */
const SOURCES = {
  SELECTED: "selected", // the customer chose it / explicitly asked for it → locked
  DETECTED: "detected", // read from the customer's own messages → may follow a clear switch
  AGENT: "agent", // set by the team in the inbox → locked
};

function info(name) {
  if (!name) return null;
  return BY_NAME.get(String(name).trim().toLowerCase()) || null;
}

function isSupported(name) {
  return Boolean(info(name));
}

/**
 * "hindi", "HINDI", "हिंदी", "Roman Hindi", "bengali", "ar", "ta_IN" → canonical
 * name, or null. Accepts a whole value only (use detect.js for free text).
 */
function normalize(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:"'()[\]🙂😊🙏👍]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return null;
  const direct = BY_NAME.get(v);
  if (direct) return direct.name;
  for (const l of LANGUAGES) if (l.aliases.includes(v)) return l.name;
  // ISO / WhatsApp codes ("hi", "hi_IN", "en-US", "ur")
  const code = v.replace("-", "_");
  for (const l of LANGUAGES) {
    if (l.waCodes.some((c) => c.toLowerCase() === code)) return l.name;
  }
  const base = code.split("_")[0];
  if (base.length === 2) {
    for (const l of LANGUAGES) if (l.waCodes.some((c) => c.split("_")[0].toLowerCase() === base)) return l.name;
  }
  // "Hindi (Devanagari)", "Hinglish (Roman script)", "Bangla / Bengali"
  if (/\bhinglish\b|roman/.test(v) && /hindi|hinglish/.test(v)) return "Hinglish";
  const found = LANGUAGES.filter((l) =>
    l.aliases.some((a) => a.length > 3 && new RegExp(`(^|[^\\p{L}\\p{M}])${escapeRe(a)}($|[^\\p{L}\\p{M}])`, "u").test(v)),
  );
  // "Hindi / Hinglish", "Hindi with English words" → not one clear language.
  return found.length === 1 ? found[0].name : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Canonical language for a Meta template language code ("hi", "en_US"…). */
function fromTemplateCode(code) {
  const c = String(code || "").trim();
  if (!c) return null;
  for (const l of LANGUAGES) if (l.waCodes.some((x) => x.toLowerCase() === c.toLowerCase())) return l.name;
  const base = c.split(/[_-]/)[0].toLowerCase();
  for (const l of LANGUAGES) if (l.waCodes.some((x) => x.split("_")[0].toLowerCase() === base)) return l.name;
  return null;
}

/** "Hindi" → "हिंदी (Hindi)" — how the options are shown to customers. */
function displayName(name) {
  const l = info(name);
  if (!l) return String(name || "");
  if (l.name === "English") return "English";
  if (l.name === "Hinglish") return "Hinglish (Roman Hindi)";
  return `${l.native} (${l.name})`;
}

module.exports = {
  LANGUAGES,
  NAMES,
  SOURCES,
  info,
  isSupported,
  normalize,
  fromTemplateCode,
  displayName,
  escapeRe,
};
