export const LOCALE_TO_LANGUAGE = {
  en: 'English',
  vi: 'Vietnamese',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  id: 'Indonesian',
  ms: 'Malay',
  tr: 'Turkish',
  pl: 'Polish',
  uk: 'Ukrainian',
  ru: 'Russian',
  ar: 'Arabic',
  he: 'Hebrew',
  el: 'Greek',
  th: 'Thai',
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
};

export const LANGUAGE_TO_LOCALE = Object.fromEntries(
  Object.entries(LOCALE_TO_LANGUAGE).map(([k, v]) => [v.toLowerCase(), k]),
);

export const SUPPORTED_UI_LOCALES = ['en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt'];

// 1. Non-Latin scripts (checked first — Japanese kana BEFORE Chinese Hanzi so Japanese text isn't misread as Chinese)
const SCRIPT_PATTERNS = [
  ['Japanese', /[\u3040-\u30ff\u31f0-\u31ff]/u],
  ['Korean', /[\uac00-\ud7af\u1100-\u11ff]/u],
  ['Chinese', /[\u3400-\u9fff]/u],
  ['Ukrainian', /[іїєґІЇЄҐ]/u],
  ['Russian', /[А-Яа-яЁё]/u],
  ['Arabic', /[\u0600-\u06ff]/u],
  ['Hebrew', /[\u0590-\u05ff]/u],
  ['Greek', /[\u0370-\u03ff]/u],
  ['Thai', /[\u0e00-\u0e7f]/u],
  ['Hindi', /[\u0900-\u097f]/u],
  ['Bengali', /[\u0980-\u09ff]/u],
  ['Tamil', /[\u0b80-\u0bff]/u],
  ['Telugu', /[\u0c00-\u0c7f]/u],
];

// 2. Diacritic-distinctive Latin languages (checked before generic ASCII/English loanwords like "app" or "fix")
const DIACRITIC_PATTERNS = [
  ['Vietnamese', /[ăâđêôơưĂÂĐÊÔƠƯ]/u],
  ['Turkish', /[ğışİ]/u],
  ['Polish', /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u],
  ['German', /[ß]/u],
  ['Spanish', /[ñÑ¿¡]/u],
  ['Portuguese', /[ãõÃÕ]/u],
];

// 3. Phrase/stopword scoring for Latin-script messages (avoids single tech words like "app" hijacking "Tạo app bán hàng")
const LATIN_STOPWORDS = [
  ['Vietnamese', /\b(tôi|bạn|mình|hãy|tạo|sửa|lỗi|ứng dụng|giúp|với|của|cho|và|không|được|này|làm|chơi|trò chơi|chi tiêu|quản lý|chạy|xem|trên|nhé|nha|vui lòng|xin chào)\b/giu],
  ['French', /\b(bonjour|salut|merci|avec|pour|dans|une|des|les|est|sont|veux|besoin|application|aide|comment|faire|créer|modifier|corriger|erreur|jeu)\b/giu],
  ['Spanish', /\b(hola|gracias|por favor|quiero|necesito|aplicación|ayuda|cómo|para|con|una|los|las|crear|arreglar|error|juego|hacer)\b/giu],
  ['German', /\b(hallo|danke|bitte|ich|möchte|brauche|anwendung|hilfe|wie|für|mit|eine|der|die|das|ist|erstellen|fehler|beheben|spiel)\b/giu],
  ['Portuguese', /\b(olá|obrigado|por favor|quero|preciso|aplicativo|ajuda|como|para|com|uma|não|criar|corrigir|erro|jogo|fazer)\b/giu],
  ['Italian', /\b(ciao|grazie|per favore|voglio|bisogno|applicazione|aiuto|come|per|con|una|non|creare|errore|gioco)\b/giu],
  ['Dutch', /\b(hallo|dank|alsjeblieft|ik|wil|nodig|applicatie|help|hoe|voor|met|een|het|niet|maken|fout)\b/giu],
  ['Indonesian', /\b(halo|terima kasih|saya|ingin|butuh|aplikasi|bantuan|tolong|bagaimana|untuk|dengan|yang|tidak|ini|buat|perbaiki)\b/giu],
  ['Malay', /\b(saya|mahu|ingin|perlukan|aplikasi|bantuan|tolong|bagaimana|untuk|dengan|yang|tidak|ini|cipta|baiki)\b/giu],
  ['English', /\b(i|you|please|hello|hi|want|need|build|create|make|fix|help|how|what|where|when|why|with|for|the|this|that|can|could|would|should|error|broken|button|game|run|preview)\b/giu],
];

export function detectUserLanguage(text = '') {
  const value = String(text || '').trim();
  if (!value) return 'English';

  for (const [language, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(value)) return language;
  }
  for (const [language, pattern] of DIACRITIC_PATTERNS) {
    if (pattern.test(value)) return language;
  }

  let bestLang = null;
  let bestScore = 0;
  for (const [language, pattern] of LATIN_STOPWORDS) {
    const matches = value.match(pattern);
    const score = matches ? matches.length : 0;
    // Slight preference to non-English matches when English score is just 1-2 tech loanwords
    const weighted = language === 'English' ? score : score * 1.35;
    if (score > 0 && weighted > bestScore) {
      bestScore = weighted;
      bestLang = language;
    }
  }
  if (bestLang) return bestLang;

  return 'Other';
}

export function detectLanguageFromLocale(locale = '') {
  const raw = String(locale || '').trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0];
  return LOCALE_TO_LANGUAGE[raw] || LOCALE_TO_LANGUAGE[primary] || null;
}

export function detectLanguageFromHeaders(acceptLanguage = '') {
  const header = String(acceptLanguage || '').trim();
  if (!header) return null;
  const parts = header
    .split(',')
    .map((item) => item.split(';')[0].trim())
    .filter(Boolean);
  for (const tag of parts) {
    const detected = detectLanguageFromLocale(tag);
    if (detected) return detected;
  }
  return null;
}

/**
 * Strict 3-tier language resolution priority:
 * 1. Language of the user's request/prompt message
 * 2. Language selected in the UI (selectedLocale / uiLocale)
 * 3. Location / browser language (Accept-Language header)
 */
export function resolveEffectiveLanguage({
  message = '',
  selectedLocale = '',
  acceptLanguage = '',
  fallback = 'English',
} = {}) {
  const rawMessage = String(message || '').trim();
  if (rawMessage) {
    const fromMessage = detectUserLanguage(rawMessage);
    if (fromMessage && fromMessage !== 'Other') return fromMessage;
  }
  const fromSelection = detectLanguageFromLocale(selectedLocale);
  if (fromSelection) return fromSelection;
  const fromLocation = detectLanguageFromHeaders(acceptLanguage);
  if (fromLocation) return fromLocation;
  return fallback || 'English';
}

export function languageInstruction(text = '', options = {}) {
  const language = (options && (options.selectedLocale || options.acceptLanguage || options.fallback))
    ? resolveEffectiveLanguage({ message: text, ...options })
    : detectUserLanguage(text);
  return languageInstructionFor(language);
}

export function languageInstructionFor(language = 'English') {
  const value = String(language || 'English').trim() || 'English';
  const target = value === 'Other' ? 'the exact language of the user request' : value;
  return `LANGUAGE RULE (STRICT PRIORITY):
1) User prompt language first, 2) Selected UI language second, 3) Location/browser language third.
Effective target language: ${target}.
- Reply to the user in ${target}. Do not switch back to English unless the user wrote in English or explicitly asked for English.
- Generated product application UI (page title, headings, navigation, buttons, placeholders, form labels, status & empty/error messages, tooltips, and README intro) MUST ALSO be written in ${target} so non-technical users can use the product immediately in that language.`;
}
