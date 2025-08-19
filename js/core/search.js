// Zero-deps query parser + record matcher + tiny highlighter.
// Supported:
//   - plain tokens:    space-separated, all must match (AND)
//   - "exact phrases": must be a substring (case-insensitive)
//   - negatives:       -token or -"phrase"
// Not supported: regex, <Tag> tokens.
//
// Fields matched (lowercased):
//   defName, defType, modDisplay, layer, path, absPath, tagMap keys/values, xml

/* ---------- public API ---------- */
export function parseQuery(q) {
  const raw = String(q || '').trim();
  if (!raw) return emptyCompiled();

  const {
    tokens, phrases, negTokens, negPhrases
  } = tokenize(raw);

  const compiled = {
    raw,
    tokens,       // ["steel", "workbench"]
    phrases,      // ["steel plate"]
    negTokens,    // ["wood"]
    negPhrases,   // ["ancient danger"]
    highlighters: {
      // Return HTML-safe string with <mark> applied to tokens/phrases
      highlight: (text) => highlightText(text, tokens, phrases)
    }
  };
  return compiled;
}

export function matches(rec, c) {
  // No query -> always true
  if (!c || (!c.tokens.length && !c.phrases.length && !c.negTokens.length && !c.negPhrases.length)) return true;

  const hay = buildHaystack(rec);
  if (!hay) return false;

  // Positives: all must match
  for (const t of c.tokens)       if (!hay.includes(t)) return false;
  for (const p of c.phrases)      if (!hay.includes(p)) return false;

  // Negatives: any match => reject
  for (const t of c.negTokens)    if (hay.includes(t))  return false;
  for (const p of c.negPhrases)   if (hay.includes(p))  return false;

  return true;
}

/* ---------- internals ---------- */

function emptyCompiled() {
  return {
    raw: '',
    tokens: [],
    phrases: [],
    negTokens: [],
    negPhrases: [],
    highlighters: { highlight: (s) => escapeHtml(String(s ?? '')) }
  };
}

function tokenize(raw) {
  // Simple state machine to pull out quoted and unquoted parts + negatives
  const tokens = [];
  const phrases = [];
  const negTokens = [];
  const negPhrases = [];

  let i = 0;
  const s = raw.trim();

  while (i < s.length) {
    // skip spaces
    if (isSpace(s[i])) { i++; continue; }

    // negative?
    let isNeg = false;
    if (s[i] === '-') { isNeg = true; i++; while (isSpace(s[i])) i++; }

    if (s[i] === '"') {
      // parse a phrase
      i++; // skip opening "
      let buf = '';
      while (i < s.length && s[i] !== '"') { buf += s[i++]; }
      if (i < s.length && s[i] === '"') i++; // closing "
      const phrase = buf.trim().toLowerCase();
      if (phrase) (isNeg ? negPhrases : phrases).push(phrase);
    } else {
      // parse a token until space
      let buf = '';
      while (i < s.length && !isSpace(s[i])) { buf += s[i++]; }
      const tok = buf.trim().toLowerCase();
      if (tok) (isNeg ? negTokens : tokens).push(tok);
    }
  }

  return { tokens, phrases, negTokens, negPhrases };
}

function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'; }

// Build a single lowercase haystack string for matching across many fields.
// Keep it cheap; no heavy parsing here—just concatenation.
function buildHaystack(rec) {
  if (!rec) return '';
  const parts = [];

  // Top-level identifiers
  push(parts, rec.defName);
  push(parts, rec.defType);

  // Source (what you see in the header pills)
  push(parts, rec.modDisplay);   // e.g., "Core", "Royalty", mod name
  push(parts, rec.layer);        // "official" | "workshop" | "dev"

  // Paths shown in the header / provenance
  push(parts, rec.path);
  push(parts, rec.absPath);

  // tagMap: keys & values are very handy for matching
  if (rec.tagMap && typeof rec.tagMap === 'object') {
    for (const [k, vals] of Object.entries(rec.tagMap)) {
      push(parts, k);
      if (Array.isArray(vals)) for (const v of vals) push(parts, v);
      else push(parts, vals);
    }
  }

  // XML fallback (kept last; potentially large)
  push(parts, rec.xml);

  return parts.join(' \n ').toLowerCase();
}

function push(arr, v) {
  if (v == null) return;
  const s = String(v).trim();
  if (s) arr.push(s);
}

/* ---------- highlighter ---------- */

function highlightText(text, tokens, phrases) {
  const src = escapeHtml(String(text ?? ''));

  // Nothing to highlight
  if ((!tokens || tokens.length === 0) && (!phrases || phrases.length === 0)) return src;

  // Work on a string, using case-insensitive replace. We escape tokens to safe regex.
  let out = src;

  // Apply phrases first (longest first) to avoid fragmenting them by token highlights
  const sortedPhrases = [...(phrases || [])].sort((a,b) => b.length - a.length);
  for (const p of sortedPhrases) {
    out = ireplace(out, p, (m) => `<mark>${m}</mark>`);
  }

  // Then single tokens, skipping ones already covered by phrases (roughly)
  const skip = new Set(sortedPhrases);
  for (const t of (tokens || [])) {
    if (skip.has(t)) continue;
    out = ireplace(out, t, (m) => `<mark>${m}</mark>`);
  }

  return out;
}

function ireplace(haystackHTML, needle, replacer) {
  if (!needle) return haystackHTML;
  const rx = new RegExp(escapeRegExp(needle), 'gi');
  // We operate on already-escaped plain text (no tags except <mark> we add).
  return haystackHTML.replace(rx, (m) => replacer(m));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
