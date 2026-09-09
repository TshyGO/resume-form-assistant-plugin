import { redactUrl } from './redact.mjs';

/**
 * Read the few fields a job page states about itself.
 *
 * Everything here is deterministic and comes from what the page declares. Nothing is
 * inferred, guessed or sent to a model: #20 requires missing fields to be filled in by the
 * user, not invented. A blank field is a correct answer.
 *
 * It runs once, when the user asks to save. It does not scan pages in the background, and
 * it reads only the elements below — never the page body, never history.
 */
export function extractJobFields(doc, href) {
  const posting = findJobPosting(doc);
  const redacted = redactUrl(href);

  return {
    company: text(companyFrom(posting)),
    title: text(posting?.title) || metaContent(doc, 'og:title') || text(doc.querySelector('h1')?.textContent) || text(doc.title),
    location: text(localityFrom(posting)),
    sourceUrl: redacted?.sourceUrl ?? '',
    dedupeUrl: redacted?.dedupeUrl ?? ''
  };
}

function findJobPosting(doc) {
  let nodes;
  try {
    nodes = doc.querySelectorAll('script[type="application/ld+json"]');
  } catch {
    return null;
  }
  for (const node of nodes ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(node.textContent);
    } catch {
      // A page with malformed structured data is still a page the user wants to save.
      continue;
    }
    const found = searchForPosting(parsed);
    if (found) return found;
  }
  return null;
}

function searchForPosting(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = searchForPosting(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const type = value['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('JobPosting')) return value;
  // Publishers commonly wrap several entities in @graph.
  return searchForPosting(value['@graph'], depth + 1);
}

function companyFrom(posting) {
  const org = posting?.hiringOrganization;
  if (typeof org === 'string') return org;
  return org?.name;
}

function localityFrom(posting) {
  const location = Array.isArray(posting?.jobLocation) ? posting.jobLocation[0] : posting?.jobLocation;
  return location?.address?.addressLocality ?? location?.address?.addressRegion;
}

function metaContent(doc, property) {
  const node = doc.querySelector(`meta[property="${property}"]`);
  return text(node?.getAttribute('content') ?? node?.content);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
