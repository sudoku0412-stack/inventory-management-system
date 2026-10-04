// Finds an expiry date in text read from a pack label (OCR output, so it expects misread characters and stray lines).
// A date after EXP, USE BY or BEST BEFORE is trusted; a date after MFG or LOT is ignored; with no keyword the latest date
// in the plausible range is a guess. A month and year alone ("EXP 03/2027") means the last day of that month.
const MONTHS = { JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4, MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12 };
// Canadian bilingual packs print two-letter month codes next to the year, e.g. "2027 MR 31".
const MONTH_CODES = { JA: 1, FE: 2, MR: 3, AL: 4, MA: 5, JN: 6, JL: 7, AU: 8, SE: 9, OC: 10, NO: 11, DE: 12 };
const NAME = '(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)';
const CODE = '(?:JA|FE|MR|AL|MA|JN|JL|AU|SE|OC|NO|DE)';
const SEP = '[-/. ]';

const EXPIRY_WORDS = /(?:\bEXP(?:IRY|IRES|IRATION)?\b|\bUSE\s*(?:BY|BEFORE)\b|\bBEST\s*(?:BEFORE|BY)\b|\bBB[ED]?\b|\bMEILLEUR\s*AVANT\b|\bUTILISER\s*AVANT\b|\bEXPIRE\b)/g;
const MADE_WORDS = /(?:\bMFG\b|\bMFD\b|\bMANUF[A-Z]*\b|\bLOT\b|\bBATCH\b|\bPROD(?:UCED|UCTION)?\b|\bPKD\b|\bPACKED\b|\bDOM\b|\bFAB(?:RIQU[EÉ])?\b)/g;

// Order matters: when two patterns start at the same character the earlier one (the more specific) wins.
const PATTERNS = [
  { kind: 'ymd', re: new RegExp(`(20\\d{2})${SEP}?(1[0-2]|0?[1-9])${SEP}?(3[01]|[12]\\d|0?[1-9])(?!\\d)`, 'g') },
  { kind: 'y-name-d', re: new RegExp(`(20\\d{2})${SEP}*(${NAME}|${CODE})${SEP}*(3[01]|[12]\\d|0?[1-9])(?!\\d)`, 'g') },
  { kind: 'd-name-y', re: new RegExp(`(?<!\\d)(3[01]|[12]\\d|0?[1-9])${SEP}*(${NAME})${SEP}*,?${SEP}*(20\\d{2}|\\d{2})(?!\\d)`, 'g') },
  { kind: 'name-y', re: new RegExp(`(?<![A-Z])(${NAME})${SEP}*,?${SEP}*(20\\d{2}|\\d{2})(?!\\d)`, 'g') },
  { kind: 'y-name', re: new RegExp(`(20\\d{2})${SEP}*(${NAME}|${CODE})(?![A-Z])`, 'g') },
  { kind: 'dmy', re: /(?<!\d)(\d{1,2})[-/. ](\d{1,2})[-/. ](20\d{2}|\d{2})(?!\d)/g },
  { kind: 'ym', re: /(?<!\d[-/.])(?<!\d)(20\d{2})[-/. ](0?[1-9]|1[0-2])(?!\d)/g },
  { kind: 'my', re: /(?<!\d[-/.])(?<!\d)(0?[1-9]|1[0-2])[-/. ](20\d{2}|\d{2})(?!\d)/g }
];

const pad = value => String(value).padStart(2, '0');
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const fullYear = value => value.length === 2 ? 2000 + Number(value) : Number(value);
const monthOf = name => MONTHS[name] ?? MONTH_CODES[name] ?? null;

// OCR reads 0 as O and 1 as I or l. Only fix characters that sit inside a number, so words are left alone.
export function repairDigits(text) {
  return String(text ?? '').toUpperCase()
    .replace(/(?<=\d)[OQ](?=\d|\b)|(?<=\b)[OQ](?=\d)/g, '0')
    .replace(/(?<=\d)[IL|](?=\d)|(?<=\b)[IL|](?=\d{3})/g, '1')
    .replace(/\S*\d\S*/g, token => /^[0-9OQILSBZ|/.:-]+$/.test(token) ? token.replace(/[OQ]/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2') : token);
}

function build(kind, groups) {
  let year, month, day = null, ambiguous = false;
  if (kind === 'ymd') [year, month, day] = [Number(groups[1]), Number(groups[2]), Number(groups[3])];
  else if (kind === 'y-name-d') [year, month, day] = [Number(groups[1]), monthOf(groups[2]), Number(groups[3])];
  else if (kind === 'd-name-y') [year, month, day] = [fullYear(groups[3]), monthOf(groups[2]), Number(groups[1])];
  else if (kind === 'name-y') [year, month] = [fullYear(groups[2]), monthOf(groups[1])];
  else if (kind === 'y-name') [year, month] = [Number(groups[1]), monthOf(groups[2])];
  else if (kind === 'ym') [year, month] = [Number(groups[1]), Number(groups[2])];
  else if (kind === 'my') [year, month] = [fullYear(groups[2]), Number(groups[1])];
  else {
    const first = Number(groups[1]), second = Number(groups[2]);
    year = fullYear(groups[3]);
    if (first > 12) [day, month] = [first, second];
    else if (second > 12) [month, day] = [first, second];
    else { [day, month] = [first, second]; ambiguous = first !== second; }
  }
  if (!month || month < 1 || month > 12 || !year) return null;
  if (day !== null && (day < 1 || day > daysIn(year, month))) return null;
  const precise = day !== null;
  return { date: `${year}-${pad(month)}-${pad(precise ? day : daysIn(year, month))}`, precision: precise ? 'day' : 'month', ambiguous };
}

function candidates(text) {
  const found = [];
  let from = 0;
  while (from < text.length) {
    let best = null;
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = from;
      const match = pattern.re.exec(text);
      if (match && (!best || match.index < best.match.index)) best = { kind: pattern.kind, match };
    }
    if (!best) break;
    const end = best.match.index + best.match[0].length;
    const value = build(best.kind, best.match);
    if (value) found.push({ ...value, raw: best.match[0].trim(), start: best.match.index, end });
    from = value ? end : best.match.index + 1;
  }
  return found;
}

// 'expiry' when an expiry word comes shortly before the date, 'made' for MFG or LOT, otherwise null.
function labelBefore(text, start, limit) {
  const window = text.slice(Math.max(limit, start - 28), start);
  const lastOf = re => { let at = -1; for (const match of window.matchAll(re)) at = match.index; return at; };
  const expiry = lastOf(EXPIRY_WORDS), made = lastOf(MADE_WORDS);
  if (expiry < 0 && made < 0) return null;
  return expiry > made ? 'expiry' : 'made';
}

/** Returns { date: 'YYYY-MM-DD', precision, confidence: 'labeled' | 'unlabeled', ambiguous, raw } or null. */
export function parseExpiry(text, { today = new Date() } = {}) {
  const source = repairDigits(text).replace(/[\t\r]+/g, ' ');
  const year = today.getUTCFullYear();
  const earliest = `${year - 5}-01-01`, latest = `${year + 15}-12-31`;
  let previousEnd = 0;
  const plausible = [];
  for (const item of candidates(source)) {
    const label = labelBefore(source, item.start, previousEnd);
    previousEnd = item.end;
    if (item.date >= earliest && item.date <= latest) plausible.push({ ...item, label });
  }
  const labeled = plausible.find(item => item.label === 'expiry');
  if (labeled) return { date: labeled.date, precision: labeled.precision, confidence: 'labeled', ambiguous: labeled.ambiguous, raw: labeled.raw };
  const rest = plausible.filter(item => item.label !== 'made');
  if (!rest.length) return null;
  const guess = rest.reduce((a, b) => b.date > a.date ? b : a);
  return { date: guess.date, precision: guess.precision, confidence: 'unlabeled', ambiguous: guess.ambiguous, raw: guess.raw };
}
