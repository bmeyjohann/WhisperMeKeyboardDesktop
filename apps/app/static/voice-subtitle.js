((root) => {
  function subtitle(text) {
    const normalized = String(text || '').trim().replace(/\s+/gu, ' ');
    // Bound presentation work only; the viewport follows the end of this single line.
    const recent = normalized;
    if (recent.length <= 160) return recent;
    const tail = Array.from(recent).slice(-160).join('');
    const boundary = tail.indexOf(' ');
    return `…${boundary >= 0 && boundary < 45 ? tail.slice(boundary + 1) : tail}`;
  }
  root.voiceSubtitle = subtitle;
  if (typeof module !== 'undefined') module.exports = { subtitle };
})(globalThis);
