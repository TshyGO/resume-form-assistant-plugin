// @ts-check
// Normalisation for comparison only. §7 is explicit that the strings the user confirmed are
// always kept as they were; these keys never replace them.
//
// The suffix lists are deliberately short. Folding too much is the worse error: it offers
// the wrong existing application as a binding candidate, and the user is being asked to
// confirm, not to audit.
const CJK_SUFFIXES = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '集团有限公司'
];

const LATIN_SUFFIXES = [
  'co.,ltd.',
  'co.,ltd',
  'co.ltd',
  'coltd',
  'ltd.',
  'ltd',
  'llc',
  'inc.',
  'inc',
  'corporation',
  'corp.',
  'corp'
];

/** @param {unknown} raw */
export function normalizeCompany(raw) {
  let value = foldWidth(String(raw ?? '')).toLowerCase();
  // Punctuation and spacing carry no identity for a company name, and they are exactly what
  // differs between "Example, Inc." and "Example Inc".
  value = value.replace(/[\s,，、.。·・]/g, '');
  for (const suffix of CJK_SUFFIXES) {
    if (value.length > suffix.length && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  for (const suffix of LATIN_SUFFIXES) {
    if (value.length > suffix.length && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value;
}

/** @param {unknown} raw */
export function normalizeTitle(raw) {
  return foldWidth(String(raw ?? '')).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The comparison key for "is this the same posting the user already saved?".
 *
 * URL is part of it but never alone: §7 says a URL is a hint, not an identity, because
 * stripping parameters can make two postings collide.
 */
/** @param {{ company?: unknown, title?: unknown, dedupeUrl?: unknown }} fields */
export function normalizeTriple({ company, title, dedupeUrl }) {
  return [
    normalizeCompany(company),
    normalizeTitle(title),
    typeof dedupeUrl === 'string' ? dedupeUrl.toLowerCase() : ''
    // A separator no normalised field can contain. Joining bare would let "星河" + "科技后端"
    // and "星河科技" + "后端" collide, and the dedupe guard would then refuse to save a
    // genuinely different posting.
  ].join('\u0001');
}

// Full-width ASCII and the ideographic space are the same characters as their half-width
// forms for identity purposes; an IME decides which one a user types.
/** @param {string} text */
function foldWidth(text) {
  return text
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}
