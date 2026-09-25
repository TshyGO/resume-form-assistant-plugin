/**
 * What one click on "保存岗位到桌面端" should show next.
 *
 * A reliable company and title is ready for the user to review. Anything less asks the
 * desktop's AI, sending only the fragments extraction already selected; if that fails
 * too, the form opens with what is known. Either way the desktop write happens only
 * after the user confirms the form. The URL is copied from the local redaction result
 * and is never produced by the model.
 */

const ROLES = new Set(['company', 'job-title', 'job-location', 'page-title']);
const SOURCES = new Set([
  'beisen-company',
  'beisen-apply-title',
  'jobposting-company',
  'jobposting-title',
  'jobposting-location',
  'og:title',
  'h1',
  'document.title'
]);
const MAX_FRAGMENTS = 8;
const MAX_FRAGMENT_CHARS = 160;
const PREFERENCE = /意向工作地点|期望工作地点|期望工作城市|期望城市|意向城市|面试站点|面试地点/;
const SENSITIVE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|cookie|authorization|bearer\s+/i;
// A link without a scheme still gives itself away by a query string or a credential key.
const CREDENTIAL = /[?&][\w.-]+=|(?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|session[_-]?id|token)\s*[=:]/i;
// A host and path such as jobs.example.com/apply. Lowercase common suffixes only, so a
// job title like "Node.js/React 开发" or "ASP.NET/C#" still goes through.
const BARE_LINK = /\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|co|cc|top|xyz|info|biz|gov|edu|app|dev|site|tech|work|jobs|me|hk|tw|jp|uk|us)(?::\d+)?[/?#]/;

export function nextSaveStep(extraction) {
  const fields = publicFields(extraction);
  if (extraction?.reliable && fields.company && fields.title) {
    return { action: 'commit', fields };
  }
  // The panel lists exactly what job-extract.mjs will send, so both use this one filter.
  const fragments = allowFragments(extraction?.fragments);
  if (fragments.length) {
    return { action: 'assist', fields, fragments, reasons: extraction?.assistReasons || [] };
  }
  return { action: 'form', fields, reason: extraction?.assistReasons?.[0] || 'manual' };
}

/** The only page fragments that may go to the desktop's AI. */
export function allowFragments(fragments) {
  if (!Array.isArray(fragments)) return [];
  const kept = [];
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'object') continue;
    const source = String(fragment.source ?? '');
    const role = String(fragment.role ?? '');
    const text = typeof fragment.text === 'string' ? fragment.text.replace(/\s+/g, ' ').trim() : '';
    const id = fragment.id;
    if (!Number.isInteger(id) || id < 1 || id > MAX_FRAGMENTS) continue;
    if (!SOURCES.has(source) || !ROLES.has(role)) continue;
    if (!text || text.length > MAX_FRAGMENT_CHARS) continue;
    if (PREFERENCE.test(text) || SENSITIVE.test(text) || CREDENTIAL.test(text) || text.includes('://') || BARE_LINK.test(text)) continue;
    if (kept.some(item => item.id === id)) continue;
    kept.push({ id, source, role, text });
    if (kept.length >= MAX_FRAGMENTS) break;
  }
  return kept;
}

export function assistDisclosure(fragments) {
  return {
    fragments: (fragments || []).map(fragment => ({
      id: fragment.id,
      source: fragment.source,
      text: fragment.text
    }))
  };
}

export function afterAssist(result, fallback) {
  const base = publicFields(fallback);
  if (result?.status === 'ok' && result.reliable && result.fields?.company && result.fields?.title) {
    const fields = {
      company: clean(result.fields.company),
      title: clean(result.fields.title),
      // The model may leave out a location extraction already had from the page.
      location: clean(result.fields.location) || base.location,
      sourceUrl: base.sourceUrl,
      dedupeUrl: base.dedupeUrl
    };
    if (fields.company && fields.title && fields.company !== fields.title) {
      return { action: 'commit', fields };
    }
  }
  const suggested = result?.fields || {};
  const fields = {
    company: clean(suggested.company) || base.company,
    title: clean(suggested.title) || base.title,
    location: clean(suggested.location) || base.location,
    sourceUrl: base.sourceUrl,
    dedupeUrl: base.dedupeUrl
  };
  if (fields.title && fields.title === fields.company) fields.title = '';
  return { action: 'form', fields, reason: result?.reason || 'manual' };
}

function publicFields(source) {
  return {
    company: clean(source?.company),
    title: clean(source?.title),
    location: clean(source?.location),
    sourceUrl: typeof source?.sourceUrl === 'string' ? source.sourceUrl : '',
    dedupeUrl: typeof source?.dedupeUrl === 'string' ? source.dedupeUrl : ''
  };
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}
