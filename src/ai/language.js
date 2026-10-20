/**
 * Detect user language for reply_language routing.
 * Never returns "Other". Uses script detection first, then Latin word scoring.
 */

const VI_CHARS = /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵĂÂĐÊÔƠƯÁÀẢÃẠẮẰẲẴẶẤẦẨẪẬÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ]/u;
const CJK = /[\u3400-\u9fff\u3040-\u30ff]/u;
const HANGUL = /[\uac00-\ud7af]/u;
const THAI = /[\u0e00-\u0e7f]/u;
const CYRILLIC = /[\u0400-\u04ff]/u;
const ARABIC = /[\u0600-\u06ff]/u;
const HEBREW = /[\u0590-\u05ff]/u;
const GREEK = /[\u0370-\u03ff]/u;
const DEVANAGARI = /[\u0900-\u097f]/u;

/** Technical tokens shared across languages — do not count toward English. */
const TECH_SKIP = new Set([
  'app', 'apps', 'build', 'fix', 'ok', 'api', 'ui', 'url', 'zip', 'github', 'docker',
  'solohost', 'publish', 'preview', 'run', 'test', 'error', 'code', 'file', 'http',
  'https', 'json', 'ai', 'token', 'model', 'node', 'npm', 'git', 'css', 'html',
]);

const WORD_TABLES = {
  Vietnamese: [
    'tôi', 'bạn', 'của', 'không', 'được', 'với', 'cho', 'này', 'là', 'và', 'có',
    'cần', 'muốn', 'tạo', 'làm', 'sửa', 'lỗi', 'ứng', 'dụng', 'giúp', 'xin', 'hãy',
    'đổi', 'thêm', 'bớt', 'xóa', 'xoá', 'màu', 'nền', 'sang', 'chạy', 'xuất', 'bản',
    'quản', 'lý', 'bán', 'hàng', 'cửa', 'hàng', 'kế', 'toán', 'trà', 'sữa', 'điểm',
    'lưu', 'được', 'một', 'những', 'các', 'tôi', 'mình', 'ạ', 'nhé', 'nữa',
  ],
  English: [
    'the', 'and', 'please', 'hello', 'want', 'need', 'help', 'how', 'what', 'where',
    'with', 'this', 'that', 'could', 'would', 'make', 'create', 'change', 'add',
    'remove', 'dark', 'mode', 'toggle', 'snake', 'game', 'my', 'a', 'an', 'to',
    'for', 'from', 'into', 'about', 'should', 'can', 'will', 'is', 'are', 'was',
  ],
  Spanish: [
    'hola', 'quiero', 'necesito', 'aplicación', 'ayuda', 'por', 'favor', 'cómo',
    'para', 'con', 'que', 'una', 'los', 'las', 'hacer', 'crear', 'cambiar',
  ],
  French: [
    'bonjour', 'veux', 'besoin', 'application', 'aide', 'merci', 'comment', 'pour',
    'avec', 'une', 'les', 'faire', 'créer', 'changer',
  ],
  German: [
    'hallo', 'möchte', 'brauche', 'anwendung', 'hilfe', 'bitte', 'wie', 'für',
    'mit', 'eine', 'der', 'die', 'das', 'machen', 'ändern',
  ],
  Portuguese: [
    'olá', 'quero', 'preciso', 'aplicativo', 'ajuda', 'favor', 'como', 'para',
    'com', 'uma', 'não', 'fazer', 'criar',
  ],
  Indonesian: [
    'halo', 'saya', 'ingin', 'butuh', 'aplikasi', 'bantuan', 'tolong', 'bagaimana',
    'untuk', 'dengan', 'yang', 'tidak', 'buat',
  ],
};

function tokenizeLatin(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFC')
    .match(/[\p{L}\p{N}']+/gu) || [];
}

function scoreLatin(tokens) {
  const scores = {};
  for (const [lang, words] of Object.entries(WORD_TABLES)) {
    const set = new Set(words);
    let n = 0;
    for (const tok of tokens) {
      if (lang === 'English' && TECH_SKIP.has(tok)) continue;
      if (set.has(tok)) n += 1;
    }
    scores[lang] = n;
  }
  return scores;
}

/**
 * @param {string} text
 * @param {{ previous?: string, uiLocale?: string }} [opts]
 */
export function detectUserLanguage(text = '', opts = {}) {
  const value = String(text || '').trim();
  const fallback = opts.previous || opts.uiLocale || 'English';
  if (!value) return fallback;

  // (a) Script / distinctive characters first
  if (VI_CHARS.test(value)) return 'Vietnamese';
  if (HANGUL.test(value)) return 'Korean';
  if (THAI.test(value)) return 'Thai';
  if (ARABIC.test(value)) return 'Arabic';
  if (HEBREW.test(value)) return 'Hebrew';
  if (GREEK.test(value)) return 'Greek';
  if (DEVANAGARI.test(value)) return 'Hindi';
  if (CYRILLIC.test(value)) {
    if (/[іїєґІЇЄҐ]/.test(value)) return 'Ukrainian';
    return 'Russian';
  }
  if (CJK.test(value)) {
    if (/[\u3040-\u30ff]/.test(value)) return 'Japanese';
    return 'Chinese';
  }

  // (b) Latin word scoring — highest score wins (not first match)
  const tokens = tokenizeLatin(value);
  const scores = scoreLatin(tokens);
  let best = null;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  // Need at least 1 distinctive non-tech hit; ties → keep previous/UI
  if (bestScore <= 0 || best == null) return fallback;

  // Tie-break: if another language equals best, prefer previous/UI if among ties
  const ties = Object.entries(scores).filter(([, s]) => s === bestScore).map(([l]) => l);
  if (ties.length > 1) {
    if (ties.includes(fallback)) return fallback;
    if (ties.includes('Vietnamese') && /[àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(value)) {
      return 'Vietnamese';
    }
  }
  return best;
}

export function languageInstruction(text = '', opts = {}) {
  const language = detectUserLanguage(text, opts);
  return `LANGUAGE RULE: Reply in the same language as the user's message. Detected language: ${language}. Always reply in the user's language. Do not translate the user's request into English unless they ask. All dynamic explanations, questions, results, and error guidance must use that language. Fixed UI labels may remain English.`;
}


export function languageInstructionFor(language = 'English') {
  const lang = String(language || 'English').trim() || 'English';
  return `LANGUAGE RULE: Reply in ${lang}. Always reply in that language. Do not translate the user's request into English unless they ask. All dynamic explanations, questions, results, and error guidance must use that language. Fixed UI labels may remain English.`;
}

export default { detectUserLanguage, languageInstruction, languageInstructionFor };
