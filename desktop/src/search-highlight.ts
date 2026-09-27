// 申请列表的搜索命中高亮。
//
// 后端（crates/archive-store 的 `ApplicationFilter.query`）对三个字段用的规则并不相同，
// 这里逐字段照搬，不做“统一规范化”：
//
// - 公司：`company_normalized LIKE %normalize_company(query)%`。库里存的是去掉公司后缀
//   （“有限公司”“Inc.” 等）之后的值，所以后缀里的字不会命中，也就不该高亮。
// - 岗位：`title_normalized LIKE %normalize_title(query)%`。全角转半角、压缩空白、小写。
// - 地点：`lower(IFNULL(location, '')) LIKE %lower(query)%`。SQLite 的 `lower()` 只处理
//   ASCII，且不做全角折叠和空白压缩。
//
// 后端没有对 LIKE 做转义，查询里的 `%`（任意串）和 `_`（任意单字符）是通配符，这里同样按
// 通配符处理，否则会出现“记录命中了却没有高亮”或“高亮了不该高亮的字”。
//
// 规范化后的文本和原文不是一一对应（全角变半角、空白折叠、大小写展开），所以先把原文拆成
// 带原始下标范围的“规范化字符”，在规范化空间里找命中，再映射回原文范围。展示文字始终是
// 原文，命中范围一律落在码点边界上，不会切坏代理对。

export type SearchField = "company" | "title" | "location";
export interface MatchRange { start: number; end: number }

/** 规范化后的一个码点，以及它在原文里占的 UTF-16 范围。 */
interface NormChar { ch: string; start: number; end: number }

// Rust `char::is_whitespace`（Unicode White_Space）。不能用 JS 的 `\s`：它多了 U+FEFF、少了 U+0085。
function isWhitespace(ch: string) {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0x85 || code === 0xa0
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000;
}

function trimWhitespace(value: string) {
  const chars = [...value];
  let from = 0;
  let to = chars.length;
  while (from < to && isWhitespace(chars[from])) from += 1;
  while (to > from && isWhitespace(chars[to - 1])) to -= 1;
  return chars.slice(from, to).join("");
}

function trimEndWhitespace(value: string) {
  const chars = [...value];
  while (chars.length && isWhitespace(chars[chars.length - 1])) chars.pop();
  return chars.join("");
}

/** 对应后端 `to_half_width`：U+FF01..U+FF5E 折成 ASCII，U+3000 折成空格。 */
function toHalfWidth(ch: string) {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0);
  if (code === 0x3000) return " ";
  return ch;
}

/**
 * 公司/岗位共用的前半段（对应 `collapse_ws(to_half_width(raw.trim())).to_lowercase()`），
 * 同时记录每个规范化码点来自原文的哪一段。
 */
function foldWide(raw: string): NormChar[] {
  const folded: NormChar[] = [];
  let pending: MatchRange | null = null;
  let offset = 0;
  for (const original of raw) {
    const start = offset;
    offset += original.length;
    const ch = toHalfWidth(original);
    if (isWhitespace(ch)) {
      // 开头的空白被 trim 掉；中间的一串空白折成一个空格，范围覆盖整串；结尾的空白丢弃。
      if (!folded.length) continue;
      pending = pending ? { start: pending.start, end: offset } : { start, end: offset };
      continue;
    }
    if (pending) {
      folded.push({ ch: " ", start: pending.start, end: pending.end });
      pending = null;
    }
    folded.push({ ch, start, end: offset });
  }
  return lowerUnicode(folded);
}

/**
 * Rust 的 `str::to_lowercase` 按整串处理（词尾 Σ 会变 ς，İ 会展开成两个码点），
 * 所以先整串小写，再按每个码点单独小写后的长度切回去，保证每个规范化码点仍有原文范围。
 */
function lowerUnicode(folded: NormChar[]): NormChar[] {
  const whole = folded.map((unit) => unit.ch).join("").toLowerCase();
  const pieces = folded.map((unit) => unit.ch.toLowerCase());
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out: NormChar[] = [];
  let cursor = 0;
  folded.forEach((unit, index) => {
    const length = pieces[index].length;
    const lowered = total === whole.length ? whole.slice(cursor, cursor + length) : pieces[index];
    cursor += length;
    for (const ch of lowered) out.push({ ch, start: unit.start, end: unit.end });
  });
  return out;
}

/** 地点：后端只有 ASCII 小写，不折叠全角、不压缩空白，也不 trim（入库时已 trim 过）。 */
function foldLocation(raw: string): NormChar[] {
  const out: NormChar[] = [];
  let offset = 0;
  for (const original of raw) {
    const start = offset;
    offset += original.length;
    out.push({ ch: original.replace(/[A-Z]/g, (letter) => letter.toLowerCase()), start, end: offset });
  }
  return out;
}

// 与后端 `COMPANY_SUFFIXES` 逐项、逐序一致。
const COMPANY_SUFFIXES = [
  "股份有限公司", "有限责任公司", "有限公司", "集团公司", "控股集团",
  "inc", "inc.", "llc", "ltd", "ltd.", "co., ltd", "co.,ltd", "co., ltd.", "co",
  "corporation", "corp", "corp.", "gmbh", "s.a.", "plc", "kg", "ag",
];
const encoder = new TextEncoder();
const utf8Length = (value: string) => encoder.encode(value).length;
const isAsciiPunctuation = (ch: string) => /^[!-/:-@[-`{-~]$/.test(ch);
const isAlphanumeric = (ch: string) => /^[\p{Alphabetic}\p{N}]$/u.test(ch);

function trimEndMatches(value: string) {
  const chars = [...value];
  while (chars.length && (isAsciiPunctuation(chars[chars.length - 1]) || isWhitespace(chars[chars.length - 1]))) chars.pop();
  return chars.join("");
}

/**
 * 对应后端 `normalize_company` 去后缀的循环。后端的长度比较用的是 UTF-8 字节数，
 * 这里也用字节数（“星有限公司”会被去掉后缀，“有限公司”本身不会）。
 * 输入必须是已经折叠、小写过的串；结果一定是输入的前缀。
 */
function stripCompanySuffixes(folded: string) {
  let current = folded;
  for (;;) {
    const trimmed = trimEndMatches(current);
    let hit = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (utf8Length(trimmed) > utf8Length(suffix) + 1 && trimmed.endsWith(suffix)) {
        const head = trimmed.slice(0, trimmed.length - suffix.length);
        const last = [...head].pop();
        if (/^[\x00-\x7f]*$/.test(suffix) && last !== undefined && isAlphanumeric(last)) continue;
        current = trimEndWhitespace(head);
        hit = true;
        break;
      }
    }
    if (!hit) return trimmed;
  }
}

function textChars(field: SearchField, raw: string): NormChar[] {
  if (field === "location") return foldLocation(raw);
  const folded = foldWide(raw);
  if (field === "title") return folded;
  const kept = stripCompanySuffixes(folded.map((unit) => unit.ch).join("")).length;
  const out: NormChar[] = [];
  let length = 0;
  for (const unit of folded) {
    if (length >= kept) break;
    out.push(unit);
    length += unit.ch.length;
  }
  return out;
}

function queryPattern(field: SearchField, query: string): string[] {
  const trimmed = trimWhitespace(query);
  if (field === "location") return [...trimmed.toLowerCase()];
  const folded = foldWide(trimmed).map((unit) => unit.ch).join("");
  return [...(field === "company" ? stripCompanySuffixes(folded) : folded)];
}

function matchesAt(text: NormChar[], at: number, segment: string[]) {
  if (at + segment.length > text.length) return false;
  return segment.every((token, index) => token === "_" || text[at + index].ch === token);
}

/**
 * 在规范化文本里找 `LIKE %pattern%` 的命中位置（码点下标，半开区间）。
 * 不含 `%`：全部不重叠的出现位置。含 `%`：按顺序各取第一处；任何一段找不到就整个字段不命中。
 */
function findLike(text: NormChar[], pattern: string[]): Array<[number, number]> {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of pattern) {
    if (token === "%") {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  if (!segments.length) return [];

  const hits: Array<[number, number]> = [];
  if (!pattern.includes("%")) {
    const [segment] = segments;
    for (let at = 0; at + segment.length <= text.length;) {
      if (matchesAt(text, at, segment)) {
        hits.push([at, at + segment.length]);
        at += segment.length;
      } else {
        at += 1;
      }
    }
    return hits;
  }

  let from = 0;
  for (const segment of segments) {
    let found = -1;
    for (let at = from; at + segment.length <= text.length; at += 1) {
      if (matchesAt(text, at, segment)) { found = at; break; }
    }
    if (found < 0) return [];
    hits.push([found, found + segment.length]);
    from = found + segment.length;
  }
  return hits;
}

/** 原文里应该高亮的范围（UTF-16 下标，升序、互不重叠）。搜索词为空或字段没命中时为空数组。 */
export function findMatchRanges(field: SearchField, raw: string | null | undefined, query: string | null | undefined): MatchRange[] {
  const text = String(raw ?? "");
  if (!text || !query || !trimWhitespace(query)) return [];
  const pattern = queryPattern(field, query);
  if (!pattern.length) return [];
  const ranges: MatchRange[] = [];
  const chars = textChars(field, text);
  for (const [from, to] of findLike(chars, pattern)) {
    const start = chars[from].start;
    const end = chars[to - 1].end;
    const last = ranges[ranges.length - 1];
    // 只合并真正重叠的（空白折叠、大小写展开会让两个规范化码点共用一段原文）。
    if (last && start < last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 转义后的 HTML：普通片段和命中片段分别转义，只有这里生成的固定 `<mark>` 是标签。
 * 原文和搜索词都不会以未转义的形式进入结果。
 */
export function highlightHtml(field: SearchField, raw: string | null | undefined, query: string | null | undefined): string {
  const text = String(raw ?? "");
  let html = "";
  let position = 0;
  for (const range of findMatchRanges(field, text, query)) {
    html += escapeHtml(text.slice(position, range.start));
    html += `<mark class="search-match">${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    position = range.end;
  }
  return html + escapeHtml(text.slice(position));
}
