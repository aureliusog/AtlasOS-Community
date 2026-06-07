// Atlas OS — TTS text preprocessing for natural speech

const STYLE_LIMITS = { brief: 4, normal: 8, detailed: 16 };

export function bulletsToPhrases(text) {
  return String(text || '')
    .replace(/^\s*[-*•]\s+(.+)$/gm, '$1. ')
    .replace(/^\s*\d+\.\s+(.+)$/gm, '$1. ');
}

export function stripEmoji(text) {
  return String(text || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripMarkdownForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

export function cleanForSpeech(text) {
  let out = stripMarkdownForSpeech(text);
  out = bulletsToPhrases(out);
  out = stripEmoji(out);
  return out.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function softenPunctuation(text) {
  return String(text || '')
    .replace(/Good evening,\s*Sir\.?/gi, 'Good evening sir.')
    .replace(/Always,\s*sir\.?/gi, 'Always sir.')
    .replace(/Yes,\s*sir\.?/gi, 'Yes sir.')
    .replace(/,\s*Sir\.?/gi, ' sir')
    .replace(/Sir,/gi, 'sir')
    .replace(/([a-z]),\s+([a-z])/gi, '$1 $2')
    .replace(/\.{2,}/g, '.')
    .replace(/!{2,}/g, '!')
    .replace(/;\s*/g, ' ')
    .replace(/:\s*/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateSentences(text, maxSentences) {
  const clean = text.trim();
  if (!clean || maxSentences <= 0) return clean;
  const parts = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  return parts.slice(0, maxSentences).join(' ').trim();
}

export function prepareSpeechText(text, style = 'brief') {
  let out = cleanForSpeech(text);
  out = softenPunctuation(out);
  const limit = STYLE_LIMITS[style] || STYLE_LIMITS.brief;
  out = truncateSentences(out, limit);
  return out.slice(0, style === 'detailed' ? 4000 : 1200);
}

export default {
  stripMarkdownForSpeech,
  cleanForSpeech,
  bulletsToPhrases,
  stripEmoji,
  softenPunctuation,
  truncateSentences,
  prepareSpeechText,
};
