// parse.js — a fast drop-in replacement for marked 18.1.3 with its default
// options (GFM on, breaks off, pedantic off, async off).
//
// Design: marked's own pipeline is kept for everything that decides what the
// HTML is — its block and inline tokenizers (vendor/marked/marked.esm.js)
// still tokenize every construct, and its Parser still renders the tokens.
// What this file replaces is only the *dispatch*: marked tries a dozen
// anchored regular expressions at every block and inline position, most of
// which cannot match, and its inline text rule is one giant backtracking
// regex. Here a cheap first-character dispatch picks the one or two
// tokenizers that can match, and plain text runs are scanned with indexOf /
// a character-class regex instead of the text rule. Every construct is still
// tokenized by marked's code, so the output is marked's output; the speed
// comes from never running regexes that cannot match.
//
// Nothing is cached across calls: parse() builds a fresh Lexer per call and
// returns what that call alone computes. If the fast path ever throws, the
// call falls back to marked.parse on the same input, so a bug costs speed,
// never correctness.
//
// Vendored marked is third-party code under vendor/marked/ (MIT, see
// vendor/marked/LICENSE and vendor/marked/NOTICE); this file is original
// work that drives it.

import { Lexer, Parser, marked } from './vendor/marked/marked.esm.js';

// The rules of the shared default tokenizer, grabbed once from a probe
// lexer. `other` holds the small helper regexes (numeric character
// references) this file needs; `inline` holds the GFM inline rules used by
// the emphasis mask.
const probeLexer = new Lexer();
const RULES = probeLexer.tokenizer.rules;
const OTHER = RULES.other;
const INLINE_RULES = RULES.inline;

// Next inline stop character: backslash, <, !, [, backtick, *, ~ or _.
// The global flag lets one exec() scan from a chosen lastIndex.
const SPECIAL_RE = /[\\<\[`*!~_]/g;

// ---------------------------------------------------------------------------
// Small helpers (own implementations of the same tiny algorithms marked uses)
// ---------------------------------------------------------------------------

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function decodeNumericCharacterReferences(text) {
  if (!OTHER.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(OTHER.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '\uFFFD';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function isEmailChar(code) {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 46 || // .
    code === 33 || // !
    code === 35 || // #
    code === 36 || // $
    code === 37 || // %
    code === 38 || // &
    code === 39 || // '
    code === 42 || // *
    code === 43 || // +
    code === 47 || // /
    code === 61 || // =
    code === 63 || // ?
    code === 95 || // _
    code === 96 || // `
    code === 123 || // {
    code === 124 || // |
    code === 125 || // }
    code === 126 || // ~
    code === 45 // -
  );
}

function isAlphanumeric(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// ---------------------------------------------------------------------------
// Emphasis mask: the same masking marked's Lexer applies before emStrong/del
// see it, so delimiters inside links, code spans, HTML and escapes are hidden.
// ---------------------------------------------------------------------------

function linkInText(lexer, text) {
  if (!text.includes('[')) {
    return false;
  }
  const linkRule = INLINE_RULES.link;
  for (const match of text.matchAll(INLINE_RULES.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(INLINE_RULES.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (
      match0.charAt(0) === '!' ||
      !Object.hasOwn(lexer.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))
    ) {
      continue;
    }
    if (refStart > 1 && linkInText(lexer, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

function maskSrc(lexer, src) {
  const links = lexer.tokens.links;
  let maskedSrc = src;

  if (links && src.includes('[') && src.includes(']')) {
    const reflinkSearch = INLINE_RULES.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(lexer, text)) {
          return (
            '[' +
            text.replace(reflinkSearch, maskReflink) +
            '][' +
            'a'.repeat(match0.length - refStart - 2) +
            ']'
          );
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }

  // The punctuation mask only matches backtick runs and backslash escapes.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(
      INLINE_RULES.anyPunctuationOutsideCode,
      (match0, code, punct) => {
        if (punct) {
          return '+'.repeat(match0.length);
        }
        if (code) {
          return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        }
        return match0;
      },
    );
  }

  // The block mask only matches links, code spans and HTML.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(INLINE_RULES.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

// ---------------------------------------------------------------------------
// Fast inline text scan: the end of the run marked's inline text rule would
// match, found with indexOf / one character-class regex instead of that rule.
// ---------------------------------------------------------------------------

// Start index of a scheme (http/https/ftp) whose "://" sits at k, or -1.
function schemeStartAt(src, k) {
  if (k >= 5 && src.slice(k - 5, k).toLowerCase() === 'https') {
    return k - 5;
  }
  if (k >= 4 && src.slice(k - 4, k).toLowerCase() === 'http') {
    return k - 4;
  }
  if (k >= 3 && src.slice(k - 3, k).toLowerCase() === 'ftp') {
    return k - 3;
  }
  return -1;
}

// One native scan for every pattern that can stop a text run: an email @,
// a scheme's ://, a www., or a mailto:/xmpp:.
const PATTERN_RE = /@|:\/\/|www\.|mailto:|xmpp:/g;

// End index (absolute) of the text run starting at `start` in `src`.
function scanTextEnd(src, start) {
  const n = src.length;
  const c0 = src.charCodeAt(start);
  let i = start + 1;
  if (c0 === 96) {
    while (i < n && src.charCodeAt(i) === 96) i++;
  } else if (c0 === 126) {
    while (i < n && src.charCodeAt(i) === 126) i++;
  }

  // A non-alphanumeric first character followed by mailto:/xmpp: is a
  // one-character text run (marked's text rule matches just that character
  // so the url rule gets the mailto: link next).
  if (
    i === start + 1 &&
    !isAlphanumeric(c0) &&
    (src.startsWith('mailto:', start + 1) || src.startsWith('xmpp:', start + 1))
  ) {
    return start + 1;
  }

  let end = n;

  // 1. Next inline stop character.
  SPECIAL_RE.lastIndex = i;
  const m = SPECIAL_RE.exec(src);
  if (m) {
    end = m.index;
  }

  // 2. Two or more spaces before a line ending end the run before them.
  let j = src.indexOf('\n', i);
  while (j !== -1 && j < end) {
    let s = j;
    while (s > i && src.charCodeAt(s - 1) === 32) {
      s--;
    }
    if (j - s >= 2) {
      end = s;
      break;
    }
    j = src.indexOf('\n', j + 1);
  }

  // 3. Email / scheme / www. / mailto: stops, from one native scan.
  PATTERN_RE.lastIndex = i;
  let pm;
  while ((pm = PATTERN_RE.exec(src)) !== null) {
    const p = pm.index;
    if (p >= end) {
      break;
    }
    const hit = pm[0];
    if (hit === '@') {
      let s = p;
      while (s > i && isEmailChar(src.charCodeAt(s - 1))) {
        s--;
      }
      if (s < p) {
        end = Math.max(s, i);
        break;
      }
    } else if (hit === '://') {
      const q = schemeStartAt(src, p);
      if (q >= i) {
        end = q;
        break;
      }
    } else if (hit === 'www.') {
      const prev = src.charCodeAt(p - 1);
      if (
        prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 ||
        prev === 11 || prev === 42 || prev === 95 || prev === 126 || prev === 40
      ) {
        end = p;
        break;
      }
    } else {
      // mailto: or xmpp: — the run ends at the non-alphanumeric char before it.
      const q = p - 1;
      if (q >= i && !isAlphanumeric(src.charCodeAt(q))) {
        end = q;
        break;
      }
    }
  }

  return end;
}

// Could marked's url rule match at position `pos` of `s`? (Necessary
// condition only; the rule itself still decides.) One anchored regex: the
// rule's alternatives all start with a scheme://, www., mailto:/xmpp:, or
// an email local part. The sticky flag anchors the match at lastIndex.
const URL_START_RE =
  /(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.|mailto:|xmpp:|[A-Za-z0-9._+-]+@)/y;
function maybeUrlStart(s, pos) {
  URL_START_RE.lastIndex = pos;
  return URL_START_RE.test(s);
}

// ---------------------------------------------------------------------------
// Fast inline tokenizing: marked's loop, but each position dispatches on its
// first character instead of trying every inline tokenizer in turn.
// ---------------------------------------------------------------------------

function inlineTokensFast(lexer, src, tokens = []) {
  const prevLinkParenPossible = lexer.state.linkParenPossible;
  lexer.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return tokenizeInlinesFast(lexer, src, tokens);
  } finally {
    lexer.state.linkParenPossible = prevLinkParenPossible;
  }
}

function tokenizeInlinesFast(lexer, src0, tokens) {
  const tokenizer = lexer.tokenizer;
  const links = lexer.tokens.links;
  const srcFull = src0;
  let maskedSrc = null;
  const getMasked = () => {
    if (maskedSrc === null) {
      // The mask only hides things inside links, code spans, HTML and
      // escapes; a run holding none of [, `, <, \ is already its own mask.
      maskedSrc =
        (srcFull.includes('*') || srcFull.includes('_') || srcFull.includes('~')) &&
        (srcFull.includes('[') ||
          srcFull.includes('`') ||
          srcFull.includes('<') ||
          srcFull.includes('\\'))
          ? maskSrc(lexer, srcFull)
          : srcFull;
    }
    return maskedSrc;
  };

  const state = lexer.state;
  const len = srcFull.length;
  let pos = 0;
  let lastPos = -1;
  let keepPrevChar = false;
  let prevChar = '';
  // Last index in the run of a `*`, `_` or `~` run that could close an
  // emphasis/strong/strikethrough span (not preceded by ASCII whitespace),
  // scanned once per run. Masking only ever hides delimiters, so a run with
  // no such closer in the unmasked source has none in the masked one either,
  // and emStrong/del would return nothing — skip the call outright.
  let closers = null;
  const getClosers = () => {
    if (closers === null) {
      closers = { '*': -1, _: -1, '~': -1 };
      const s = srcFull;
      for (let k = 0; k < s.length; k++) {
        const ch = s[k];
        if (ch !== '*' && ch !== '_' && ch !== '~') {
          continue;
        }
        const prev = k === 0 ? '\n' : s[k - 1];
        let j = k + 1;
        while (j < s.length && s[j] === ch) {
          j++;
        }
        if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
          closers[ch] = k;
        }
        k = j - 1;
      }
    }
    return closers;
  };
  while (pos < len) {
    if (pos === lastPos) {
      throw new Error('Infinite loop on byte: ' + srcFull.charCodeAt(pos));
    }
    lastPos = pos;
    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;

    const ch = srcFull[pos];
    let token;

    if (ch === '\\') {
      token = tokenizer.escape(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
      token = tokenizer.br(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
    } else if (ch === '<') {
      token = tokenizer.tag(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
      token = tokenizer.autolink(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
    } else if (ch === '[' || ch === '!') {
      // The link rule needs a literal `](` ahead (label close, paren open)
      // and the reflink rules need a `]`; without them the big regexes
      // cannot match, so skip them.
      const rest = srcFull.slice(pos);
      if (rest.includes(']')) {
        if (rest.includes('](')) {
          token = tokenizer.link(rest);
          if (token) {
            pos += token.raw.length;
            tokens.push(token);
            continue;
          }
        }
        token = tokenizer.reflink(rest, links);
        if (token) {
          pos += token.raw.length;
          const lastToken = tokens[tokens.length - 1];
          if (token.type === 'text' && lastToken?.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
      }
    } else if (ch === '*' || ch === '_') {
      if (getClosers()[ch] >= pos) {
        token = tokenizer.emStrong(srcFull.slice(pos), getMasked(), prevChar);
        if (token) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      }
    } else if (ch === '`') {
      token = tokenizer.codespan(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
    } else if (ch === '~') {
      if (getClosers()['~'] >= pos) {
        token = tokenizer.del(srcFull.slice(pos), getMasked(), prevChar);
        if (token) {
          pos += token.raw.length;
          tokens.push(token);
          continue;
        }
      }
    } else if (ch === ' ') {
      token = tokenizer.br(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
    } else if (!state.inLink && maybeUrlStart(srcFull, pos)) {
      token = tokenizer.url(srcFull.slice(pos));
      if (token) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
    }

    // Plain text: scan the run instead of running the text rule.
    const end = scanTextEnd(srcFull, pos);
    if (end <= pos) {
      throw new Error('Infinite loop on byte: ' + srcFull.charCodeAt(pos));
    }
    const raw = srcFull.slice(pos, end);
    const escaped = state.inRawBlock;
    const text = escaped ? raw : decodeNumericCharacterReferences(raw);
    pos = end;
    if (raw.charCodeAt(raw.length - 1) !== 95) {
      prevChar = raw.charAt(raw.length - 1);
    }
    keepPrevChar = true;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken?.type === 'text') {
      lastToken.raw += raw;
      lastToken.text += text;
    } else {
      tokens.push({ type: 'text', raw, text });
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Fast block tokenizing: marked's loop, but each position dispatches on its
// first line instead of trying every block tokenizer in turn. The trial
// order is unchanged; tokenizers that cannot match the line are skipped.
// ---------------------------------------------------------------------------

function secondLine(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) {
    return null;
  }
  const nl2 = src.indexOf('\n', nl + 1);
  return nl2 === -1 ? src.slice(nl + 1) : src.slice(nl + 1, nl2);
}

// Is src[start..end) (one line, no \n inside) a GFM table delimiter row?
// The row is ` {0,3}` then cells of `:?-+:?` separated by `|` (with optional
// spaces around the pipes and an optional leading/trailing pipe), matching
// marked's delimiter group exactly: `::--` and `-:-` are not rows, `:-:`,
// `- | -` and `| - |` are.
function isTableDelimiterRow(src, start, end) {
  let i = start;
  while (i < start + 3 && src.charCodeAt(i) === 32) {
    i++;
  }
  if (src.charCodeAt(i) === 124) {
    // '|'
    i++;
    while (src.charCodeAt(i) === 32) {
      i++;
    }
  }
  let cells = 0;
  for (;;) {
    if (src.charCodeAt(i) === 58) {
      i++; // ':'
    }
    let dashes = 0;
    while (src.charCodeAt(i) === 45) {
      i++;
      dashes++;
    }
    if (dashes === 0) {
      return false;
    }
    if (src.charCodeAt(i) === 58) {
      i++; // ':'
    }
    cells++;
    while (src.charCodeAt(i) === 32) {
      i++;
    }
    if (src.charCodeAt(i) === 124) {
      // '|'
      i++;
      while (src.charCodeAt(i) === 32) {
        i++;
      }
      if (i >= end) {
        return cells > 0; // trailing pipe
      }
      continue;
    }
    break;
  }
  return cells > 0 && i >= end;
}

// Necessary condition for the GFM table rule: the next line is a delimiter row.
function tableDelimiterAhead(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) {
    return false;
  }
  const start = nl + 1;
  let end = src.indexOf('\n', start);
  if (end === -1) {
    end = src.length;
  }
  return isTableDelimiterRow(src, start, end);
}

// Does the line src[start..end) (no \n inside; hasNewline says a \n follows
// it in src) end a paragraph at its start? Mirrors the negative lookahead of
// marked's GFM paragraph rule: hr, heading, blockquote, fences, list, html,
// table, or a blank line. Setext underlines do not interrupt (the lheading
// tokenizer runs before the paragraph one and claims them first).
function paragraphLineInterrupts(src, start, end, hasNewline) {
  if (start === end) {
    return true; // empty line: the paragraph rule's [^\n]+ cannot match it
  }
  let i = start;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) {
      break;
    }
    i++;
  }
  if (i === end) {
    // spaces/tabs only: ends the paragraph only when a \n follows (the
    // [ \t]+\n alternative); as the last line it is paragraph text
    return hasNewline;
  }
  // Leading spaces for the interrupt patterns: at most 3, spaces only.
  let sp = 0;
  while (sp < 3 && src.charCodeAt(start + sp) === 32) {
    sp++;
  }
  const k = start + sp;
  const c0 = src.charCodeAt(k);
  if (c0 !== 32 && c0 !== 9) {
    if (c0 === 62) {
      return true; // blockquote
    }
    if (c0 === 35) {
      // ATX heading: 1-6 #, then whitespace or end of line
      let h = k;
      while (h < end && src.charCodeAt(h) === 35) {
        h++;
      }
      const hashes = h - k;
      if (hashes >= 1 && hashes <= 6) {
        if (h === end) {
          return true;
        }
        const c = src.charCodeAt(h);
        if (c === 32 || c === 9 || c === 11 || c === 12) {
          return true;
        }
      }
    }
    if (c0 === 96) {
      // fenced code: 3+ backticks whose info string holds no backtick
      let b = k;
      while (b < end && src.charCodeAt(b) === 96) {
        b++;
      }
      if (b - k >= 3) {
        const bt = src.indexOf('`', b);
        if (bt === -1 || bt >= end) {
          return true;
        }
      }
    }
    if (c0 === 126 && src.startsWith('~~~', k)) {
      return true; // tilde fence: any info string
    }
    if (c0 === 45 || c0 === 95 || c0 === 42) {
      // hr: the whole line is one marker + spaces/tabs, 3+ markers
      let count = 0;
      let hr = true;
      for (let j = k; j < end; j++) {
        const c = src.charCodeAt(j);
        if (c === c0) {
          count++;
        } else if (c !== 32 && c !== 9) {
          hr = false;
          break;
        }
      }
      if (hr && count >= 3) {
        return true;
      }
    }
    if (c0 === 45 || c0 === 42 || c0 === 43) {
      // list: marker, 1+ spaces/tabs, then a non-space/tab char
      let j = k + 1;
      let spaces = 0;
      while (j < end && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) {
        j++;
        spaces++;
      }
      if (spaces > 0 && j < end) {
        return true;
      }
    }
    if (c0 === 49) {
      // ordered list: only `1.` or `1)` can interrupt a paragraph
      const d = src.charCodeAt(k + 1);
      if (d === 46 || d === 41) {
        let j = k + 2;
        let spaces = 0;
        while (j < end && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) {
          j++;
          spaces++;
        }
        if (spaces > 0 && j < end) {
          return true;
        }
      }
    }
    if (c0 === 60 && isHtmlBeginLine(src.slice(start, end), 3, hasNewline)) {
      return true;
    }
  }
  // Table: this line is the header, the next line a delimiter row. (The
  // paragraph lookahead embeds the table regex only, not the tokenizer's
  // column-count gate, so any valid delimiter row interrupts.)
  if (hasNewline) {
    const nextStart = end + 1;
    let nextEnd = src.indexOf('\n', nextStart);
    if (nextEnd === -1) {
      nextEnd = src.length;
    }
    if (isTableDelimiterRow(src, nextStart, nextEnd)) {
      return true;
    }
  }
  return false;
}

// Fast paragraph tokenizer: marked's paragraph rule, as a line scan. The
// first line is always paragraph text (the block dispatch already ruled out
// every other block start here); each following line is consumed until a
// blank line or an interrupt line. Returns exactly what marked's
// paragraph() returns, including the queued inline tokens.
function fastParagraph(lexer, src) {
  const n = src.length;
  let end = src.indexOf('\n');
  if (end === -1) {
    end = n;
  }
  if (end === 0) {
    return undefined; // empty first line: no paragraph
  }
  let pos = end;
  while (pos < n) {
    const lineStart = pos + 1;
    let lineEnd = src.indexOf('\n', lineStart);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) {
      lineEnd = n;
    }
    if (paragraphLineInterrupts(src, lineStart, lineEnd, hasNewline)) {
      break;
    }
    pos = lineEnd;
  }
  const raw = src.slice(0, pos);
  const text =
    raw.charCodeAt(raw.length - 1) === 10 ? raw.slice(0, -1) : raw;
  return { type: 'paragraph', raw, text, tokens: lexer.inline(text) };
}

function isSetextUnderline(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) {
    i++;
  }
  if (i >= line.length) {
    return false;
  }
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) {
    return false;
  }
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) {
    j++;
  }
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) {
    j++;
  }
  return j === line.length;
}

// Necessary condition for the setext-heading rule: some line before the next
// blank line is an underline. (A line that cannot be reached still costs one
// wasted lheading call; a line that can be reached is never missed, because
// the heading's text cannot cross a blank line.)
function underlineAhead(src) {
  let pos = src.indexOf('\n');
  while (pos !== -1) {
    const start = pos + 1;
    let end = src.indexOf('\n', start);
    if (end === -1) {
      end = src.length;
    }
    const line = src.slice(start, end);
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const cc = line.charCodeAt(k);
      if (cc !== 32 && cc !== 9) {
        blank = false;
        break;
      }
    }
    if (blank) {
      return false;
    }
    if (isSetextUnderline(line)) {
      return true;
    }
    pos = end < src.length ? end : -1;
  }
  return false;
}

// Block-level tag names that can start an HTML block (marked's _tag list).
const BLOCK_TAGS = new Set(
  (
    'address|article|aside|base|basefont|blockquote|body|caption|center|col|' +
    'colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|' +
    'footer|form|frame|frameset|head|header|hr|html|iframe|legend|li|link|' +
    'main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|' +
    'section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
  ).split('|'),
);
for (let h = 1; h <= 6; h++) {
  BLOCK_TAGS.add('h' + h);
}

const TAB_SPACES = ['', ' ', '  ', '   ', '    '];

// Expand tabs in the leading whitespace of `str`, where `str` starts at
// column `startCol` (marked's expandTabs, restricted to the leading run).
function expandTabsPrefix(str, startCol) {
  let i = 0;
  let col = startCol;
  let out = null;
  while (i < str.length) {
    const c = str.charCodeAt(i);
    if (c === 32) {
      if (out !== null) {
        out += ' ';
      }
      col++;
      i++;
    } else if (c === 9) {
      if (out === null) {
        out = str.slice(0, i);
      }
      const added = 4 - (col % 4);
      out += TAB_SPACES[added];
      col += added;
      i++;
    } else {
      break;
    }
  }
  return out === null ? str : out + str.slice(i);
}

function firstNonSpace(line) {
  for (let k = 0; k < line.length; k++) {
    if (line.charCodeAt(k) !== 32) {
      return k;
    }
  }
  return -1;
}

// Column of the first non-space character with every tab expanded to four
// spaces (marked's `line.replace(/\t/g, '    ').search(nonSpaceChar)`):
// a tab in the leading whitespace counts as four columns, not as a
// non-space character at its own position.
function firstNonSpaceTabExpanded(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      col += 4;
    } else if (c === 32) {
      col++;
    } else {
      return col;
    }
  }
  return col;
}

function leadingSpaces(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) {
    k++;
  }
  return k;
}

// The line interrupts a list item as a fence / heading / blockquote / bullet /
// hr / HTML block start, mirroring marked's per-line regexes with char checks.
// `indent` is the item's indent: at most that many leading spaces are allowed.
function isFencesLine(line, indent) {
  const sp = leadingSpaces(line);
  if (sp > indent) {
    return false;
  }
  return line.startsWith('```', sp) || line.startsWith('~~~', sp);
}

function isHeadingLine(line, indent) {
  const sp = leadingSpaces(line);
  if (sp > indent) {
    return false;
  }
  let k = sp;
  while (k < line.length && line.charCodeAt(k) === 35) {
    k++;
  }
  const hashes = k - sp;
  if (hashes < 1 || hashes > 6) {
    return false;
  }
  const c = line.charCodeAt(k);
  // the heading rule wants \s or end of line: space, tab, VT, FF
  return Number.isNaN(c) || c === 32 || c === 9 || c === 11 || c === 12;
}

function isBlockquoteLine(line, indent) {
  const sp = leadingSpaces(line);
  return sp <= indent && line.charCodeAt(sp) === 62;
}

function isBulletLine(line, indent) {
  const sp = leadingSpaces(line);
  if (sp > indent) {
    return false;
  }
  let k = sp;
  const c = line.charCodeAt(k);
  if (c === 42 || c === 43 || c === 45) {
    k++;
  } else if (c >= 48 && c <= 57) {
    let digits = 0;
    while (digits < 9 && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) {
      k++;
      digits++;
    }
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) {
      return false;
    }
    k++;
  } else {
    return false;
  }
  const next = line.charCodeAt(k);
  return Number.isNaN(next) || next === 32 || next === 9;
}

function isHrLine(line, indent) {
  const sp = leadingSpaces(line);
  if (sp > indent) {
    return false;
  }
  const c = line.charCodeAt(sp);
  if (c !== 45 && c !== 95 && c !== 42) {
    return false;
  }
  let count = 0;
  for (let i = sp; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc === c) {
      count++;
    } else if (cc !== 32 && cc !== 9) {
      return false;
    }
  }
  return count >= 3;
}

function isHtmlBeginLine(line, indent, endIsNewline = true) {
  const sp = leadingSpaces(line);
  if (sp > indent || line.charCodeAt(sp) !== 60) {
    return false;
  }
  const c1 = line.charCodeAt(sp + 1);
  if (c1 === 33) {
    // <!--, <![CDATA[, or <! + letter
    if (line.startsWith('<!--', sp)) {
      return true;
    }
    if (line.slice(sp, sp + 9).toLowerCase() === '<![cdata[') {
      return true;
    }
    const c2 = line.charCodeAt(sp + 2);
    return (c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122);
  }
  if (c1 === 63) {
    return true; // <?
  }
  let nameStart = sp + 1;
  if (c1 === 47) {
    nameStart = sp + 2; // </
  }
  let k = nameStart;
  const first = line.charCodeAt(k);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) {
    return false;
  }
  while (k < line.length) {
    const cc = line.charCodeAt(k);
    if (
      (cc >= 65 && cc <= 90) ||
      (cc >= 97 && cc <= 122) ||
      (cc >= 48 && cc <= 57) ||
      cc === 45
    ) {
      k++;
    } else {
      break;
    }
  }
  const name = line.slice(nameStart, k).toLowerCase();
  const next = line.charCodeAt(k);
  const atEnd = Number.isNaN(next);
  // script/pre/style/textarea only count as an OPENING tag: both the
  // paragraph lookahead and the list html rule use `<(?:script|pre|...)`
  // with no `/`. A closing `</pre>` is not an HTML block start (those names
  // are not in _tag either), so it does not interrupt a paragraph or a list
  // item — cm-148 keeps `</pre>` inside its paragraph.
  if (
    c1 !== 47 &&
    (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')
  ) {
    return (
      atEnd || next === 32 || next === 9 || next === 10 || next === 13 || next === 12 ||
      next === 11 || next === 62
    );
  }
  if (!BLOCK_TAGS.has(name)) {
    return false;
  }
  // A block tag name ends the paragraph only when followed by a space, `>`,
  // `/>`, or a newline (the html rule's `(?: +|\n|/?>)`); a bare `<div` as
  // the last line, with no newline after it, does not interrupt.
  return (
    (atEnd && endIsNewline) ||
    next === 32 ||
    next === 62 ||
    (next === 47 && line.charCodeAt(k + 1) === 62)
  );
}

// Fast list tokenizing: marked's list() with the per-line regex tests replaced
// by the char checks above. Returns undefined when the list needs something
// this fast path does not handle (tabs in leading whitespace, a setext
// underline lazily continuing an item); the caller then runs marked's own
// list() on the same input. Nothing is mutated before a bail, so falling
// back is free. The item-splitting below mirrors marked's list() line for
// line; the two final passes (tokenizing items, task checkboxes) are the
// same logic as marked's.
function fastList(lexer, src) {
  const tokenizer = lexer.tokenizer;
  const rules = tokenizer.rules;
  let cap = rules.block.list.exec(src);
  if (!cap) {
    return undefined;
  }
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = OTHER.listItemRegex(bull);
  let endsWithBlankLine = false;

  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) {
      break;
    }

    const firstLineOfSrc = src.indexOf('\n') === -1 ? src : src.slice(0, src.indexOf('\n'));
    if (isHrLine(firstLineOfSrc, 3)) {
      break;
    }

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    // A tab after the bullet expands from the bullet's column, as marked does.
    const line0 = expandTabsPrefix(firstLine, bulletIndent);
    const nl = src.indexOf('\n');
    const nextLine0 = nl === -1 ? src : src.slice(0, nl);
    const blankLine0 = !line0.trim();

    let indent = 0;
    if (blankLine0) {
      indent = bulletIndent + 1;
    } else {
      indent = firstNonSpace(line0);
      if (indent > 4) {
        indent = 1;
      }
      itemContents = line0.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine0 && !nextLine0.trim()) {
      src = src.substring(nextLine0.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      // marked's per-line interrupt regexes allow at most min(3, indent-1)
      // leading spaces (cachedIndentRegex), not `indent` spaces: a line
      // indented further than that is nested content, not an interruption.
      const reIndent = Math.max(0, Math.min(3, indent - 1));
      let line = line0;
      let blankLine = blankLine0;
      while (src) {
        const nl2 = src.indexOf('\n');
        const rawLine = nl2 === -1 ? src : src.slice(0, nl2);
        // Interrupt tests run on the raw line (a tab does not count as the
        // spaces those patterns allow); content uses the tab-expanded line.
        const nextLine = rawLine;
        const nextLineExpanded = expandTabsPrefix(rawLine, 0);

        if (isFencesLine(nextLine, reIndent)) {
          break;
        }
        if (isHeadingLine(nextLine, reIndent)) {
          break;
        }
        if (isHtmlBeginLine(nextLine, reIndent)) {
          break;
        }
        if (isBlockquoteLine(nextLine, reIndent)) {
          break;
        }
        if (isBulletLine(nextLine, reIndent)) {
          break;
        }
        if (isHrLine(nextLine, reIndent)) {
          break;
        }

        if (firstNonSpace(nextLineExpanded) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineExpanded.slice(indent);
        } else {
          if (blankLine) {
            break;
          }
          // A lazy continuation ends the item when the previous (dedented)
          // line looks like indented code: tabs expand to four spaces here,
          // so a line like ` \t tabbed` starts at column 5.
          if (firstNonSpaceTabExpanded(line) >= 4) {
            break;
          }
          if (isFencesLine(line, reIndent)) {
            break;
          }
          if (isHeadingLine(line, reIndent)) {
            break;
          }
          if (isHtmlBeginLine(line, reIndent)) {
            break;
          }
          if (isHrLine(line, reIndent)) {
            break;
          }
          // A setext underline lazily continuing the item: let marked's
          // list() handle it.
          if (/^ {0,3}(?:=+|-+) *$/.test(nextLine)) {
            return undefined;
          }
          itemContents += '\n' + nextLine;
        }

        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = nextLineExpanded.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (OTHER.doubleBlankLine.test(raw)) {
        endsWithBlankLine = true;
      }
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: !!OTHER.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  for (const item of list.items) {
    lexer.state.top = false;
    item.tokens = lexer.blockTokens(item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks =
        spacers.length > 0 && spacers.some((t) => OTHER.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(OTHER.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(OTHER.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(OTHER.listReplaceTask, '');
      for (let i = lexer.inlineQueue.length - 1; i >= 0; i--) {
        if (OTHER.listIsTask.test(lexer.inlineQueue[i].src)) {
          lexer.inlineQueue[i].src = lexer.inlineQueue[i].src.replace(
            OTHER.listReplaceTask,
            '',
          );
          break;
        }
      }
      const taskRaw = OTHER.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            ['paragraph', 'text'].includes(item.tokens[0].type) &&
            'tokens' in item.tokens[0] &&
            item.tokens[0].tokens
          ) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              tokens: [checkboxToken],
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') {
          token.type = 'paragraph';
        }
      }
    }
  }

  return list;
}

function blockTokensFast(lexer, src, tokens = [], lastParagraphClipped = false) {
  const tokenizer = lexer.tokenizer;
  const state = lexer.state;

  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    let token;
    const c0 = src.charCodeAt(0);
    let sp = 0;
    while (sp < 4 && src.charCodeAt(sp) === 32) {
      sp++;
    }
    const m = sp < 4 ? src[sp] : '';
    const indented = sp === 4 || c0 === 9;

    const trySpace = c0 === 32 || c0 === 9 || c0 === 10;
    const tryCode = c0 === 32 || c0 === 9;
    const tryFences = sp < 4 && (m === '`' || m === '~');
    const tryHeading = sp < 4 && m === '#';
    const tryHr = sp < 4 && (m === '-' || m === '_' || m === '*');
    const tryBlockquote = sp < 4 && m === '>';
    const tryList =
      sp < 4 && (m === '*' || m === '+' || m === '-' || (m >= '0' && m <= '9'));
    const tryHtml = sp < 4 && m === '<';
    const tryDef = sp < 4 && m === '[';
    const tryTable = !indented && tableDelimiterAhead(src);
    const tryLheading = !indented && underlineAhead(src);

    // newline
    if (trySpace && (token = tokenizer.space(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // code
    if (tryCode && (token = tokenizer.code(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fences
    if (tryFences && (token = tokenizer.fences(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // heading
    if (tryHeading && (token = tokenizer.heading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // hr
    if (tryHr && (token = tokenizer.hr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // blockquote
    if (tryBlockquote && (token = tokenizer.blockquote(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // list (fast path first, marked's own list() on anything it declines)
    if (tryList && (token = fastList(lexer, src) ?? tokenizer.list(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // html
    if (tryHtml && (token = tokenizer.html(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // def
    if (tryDef && (token = tokenizer.def(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        if (!lexer.tokens.links[token.tag]) {
          lexer.tokens.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    // table (gfm)
    if (tryTable && (token = tokenizer.table(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // lheading
    if (tryLheading && (token = tokenizer.lheading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // top-level paragraph (line scan instead of the paragraph regex)
    if (state.top && (token = fastParagraph(lexer, src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lexer.inlineQueue.pop();
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      // (cutSrc equals src: there are no extensions, so the paragraph is
      // never clipped; the flag stays false, as in marked's loop.)
      src = src.substring(token.raw.length);
      continue;
    }

    // text
    if ((token = tokenizer.text(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lexer.inlineQueue.pop();
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    return marked.parse(markdown);
  }
  try {
    const lexer = new Lexer();
    lexer.blockTokens = (src, tokens, lastParagraphClipped) =>
      blockTokensFast(lexer, src, tokens, lastParagraphClipped);
    lexer.inlineTokens = (src, tokens) => inlineTokensFast(lexer, src, tokens);
    const tokens = lexer.lex(markdown);
    return Parser.parse(tokens);
  } catch {
    return marked.parse(markdown);
  }
}
