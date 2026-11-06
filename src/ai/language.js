const COMMON = [
  ['English', /(?:^|\s)i(?:\s|$)|\b(please|hello|hi|you|want|need|build|app|fix|help|how|what|where|with|for|the|this|that|can|could|would)\b/iu],
  ['Vietnamese', /\b(xin|hãy|tôi|bạn|ứng dụng|giúp|sửa|lỗi|cho|và|của|không|được|này|với|tạo|làm)\b|[ăâđêôơưĂÂĐÊÔƠƯ]/iu],
  ['Spanish', /\b(hola|quiero|necesito|aplicación|ayuda|por favor|cómo|para|con|que|una|el|la|los|las)\b|[ñ¿¡]/iu],
  ['French', /\b(bonjour|je|veux|besoin|application|aide|merci|comment|pour|avec|une|le|la|les|est)\b|[àâçéèêëîïôûùüÿœæ]/iu],
  ['German', /\b(hallo|ich|möchte|brauche|anwendung|hilfe|bitte|wie|für|mit|eine|der|die|das|ist)\b|[äöüß]/iu],
  ['Portuguese', /\b(olá|quero|preciso|aplicativo|ajuda|por favor|como|para|com|uma|não)\b|[ãõç]/iu],
  ['Italian', /\b(ciao|voglio|bisogno|applicazione|aiuto|per favore|come|per|con|una|il|la|gli|non)\b/iu],
  ['Dutch', /\b(hallo|ik|wil|nodig|applicatie|help|alsjeblieft|hoe|voor|met|een|de|het|niet)\b/iu],
  ['Indonesian', /\b(halo|saya|ingin|butuh|aplikasi|bantuan|tolong|bagaimana|untuk|dengan|yang|tidak|ini)\b/iu],
  ['Malay', /\b(saya|mahu|ingin|perlukan|aplikasi|bantuan|tolong|bagaimana|untuk|dengan|yang|tidak|ini)\b/iu],
  ['Turkish', /\b(merhaba|ben|istiyorum|ihtiyacım|uygulama|yardım|lütfen|nasıl|için|ile|bir|bu|değil)\b|[ğışçöüİ]/iu],
  ['Polish', /\b(cześć|chcę|potrzebuję|aplikacja|pomoc|proszę|jak|dla|z|nie|jest|to)\b|[ąćęłńóśźż]/iu],
  ['Ukrainian', /[іїєґІЇЄҐ]/u],
  ['Russian', /[А-Яа-яЁё]/u],
  ['Arabic', /[\u0600-\u06ff]/u],
  ['Hebrew', /[\u0590-\u05ff]/u],
  ['Greek', /[\u0370-\u03ff]/u],
  ['Chinese', /[\u3400-\u9fff]/u],
  ['Japanese', /[\u3040-\u30ff]/u],
  ['Korean', /[\uac00-\ud7af]/u],
  ['Thai', /[\u0e00-\u0e7f]/u],
  ['Hindi', /[\u0900-\u097f]/u],
  ['Bengali', /[\u0980-\u09ff]/u],
  ['Tamil', /[\u0b80-\u0bff]/u],
  ['Telugu', /[\u0c00-\u0c7f]/u],
];

export function detectUserLanguage(text = '') {
  const value = String(text || '').trim();
  if (!value) return 'English';
  for (const [language, pattern] of COMMON) if (pattern.test(value)) return language;
  return 'Other';
}

export function languageInstruction(text = '') {
  const language = detectUserLanguage(text);
  return `LANGUAGE RULE: Reply in the same language as the user's message. Detected language: ${language}. Do not translate the user's request into English unless the user asks for a translation. All dynamic explanations, questions, results, and error guidance must use that language. Fixed UI labels and fixed template headings may remain English.`;
}

export function languageInstructionFor(language = 'English') {
  const value = String(language || 'English').trim() || 'English';
  return `LANGUAGE RULE: Reply in the same language as the user's message. Detected language: ${value}. Do not translate the user's request into English unless the user asks for a translation. All dynamic explanations, questions, results, and error guidance must use that language. Fixed UI labels and fixed template headings may remain English.`;
}
