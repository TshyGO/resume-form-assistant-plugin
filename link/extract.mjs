import { redactUrl } from './redact.mjs';

/**
 * Read the few fields a job page states about itself.
 *
 * Local rules only. Nothing here calls a model or reads form values, resume text, cookies
 * or the raw URL. Missing fields stay blank. Page titles are candidates for a later,
 * separate assist step; they are not the job title.
 *
 * Reliable company and title come from a site-limited rule or from JobPosting. Those two
 * sources are recorded so the caller can see a conflict instead of guessing.
 */

const MAX_FRAGMENT_CHARS = 160;
const MAX_FRAGMENTS = 8;
const MAX_FIELD_CHARS = 80;

const COMPANY_SELECTOR = [
  '[class*="company-name"]',
  '[class*="companyName"]',
  '[class*="company_name"]',
  '[class*="logo-name"]',
  '[class*="logoName"]',
  '[class*="tenant-name"]',
  '[class*="tenantName"]'
].join(',');

const TEXT_SELECTOR = [
  'h1', 'h2', 'h3', 'p', 'li', 'dt', 'dd', 'strong', 'span',
  '[class*="company"]', '[class*="job"]', '[class*="title"]', '[class*="position"]', '[class*="logo"]',
  '[class*="tenant-name"]', '[class*="tenantName"]'
].join(',');

const APPLY_PHRASE = /(?:你|您)正在投递(?:的)?职位\s*[:：]\s*(.+)$/;
const PREFERENCE = /意向工作地点|期望工作地点|期望工作城市|期望城市|意向城市|面试站点|面试地点/;
const SENSITIVE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/;
const FORM_LABEL = /^(姓名|手机|手机号|电话|邮箱|证件|证件号码|身份证|密码|简历|我的信息)$/;

export function extractJobFields(doc, href) {
  const redacted = redactUrl(href);
  const host = pageHost(href);
  const postings = findJobPostings(doc);
  const texts = shortTexts(doc);

  const jobCompanies = unique(postings.map(companyFrom).map(cleanField).filter(Boolean));
  const jobTitles = unique(postings.map(posting => cleanField(posting?.title)).filter(Boolean));
  const jobLocation = firstJobLocation(postings);

  const apply = findApplyPhrase(texts);
  // Host and page type both have to match. A job list on the same host is not this form.
  const beisenApply = isBeisenApplyHost(host) && Boolean(apply);
  const labeledCompanies = beisenApply ? companyLabels(doc, texts, apply) : [];

  const companyValues = [...labeledCompanies, ...jobCompanies];
  const titleValues = [...(beisenApply && apply?.title ? [apply.title] : []), ...jobTitles];

  const companyConflict = unique(companyValues).length > 1;
  const titleConflict = unique(titleValues).length > 1;
  const company = companyConflict ? '' : (companyValues[0] || '');
  const titleRaw = titleConflict ? '' : (titleValues[0] || '');
  const swapped = Boolean(company && titleRaw && company === titleRaw);
  const title = swapped ? '' : titleRaw;
  const location = jobLocation && !PREFERENCE.test(jobLocation) ? jobLocation : '';

  const ogTitle = metaContent(doc, 'og:title');
  const h1 = heading(doc);
  const documentTitle = cleanField(doc?.title);
  const pageTitles = unique([ogTitle, h1, documentTitle].filter(Boolean));
  const siteName = metaContent(doc, 'og:site_name');

  const assistReasons = [];
  if (!company) assistReasons.push('missing_company');
  if (!title) assistReasons.push('missing_title');
  if (swapped) assistReasons.push('swapped');
  if (companyConflict) assistReasons.push('company_conflict');
  if (titleConflict) assistReasons.push('title_conflict');
  if (!title && pageTitles.length && pageTitles.every(value => value === company || value === siteName)) {
    assistReasons.push('site_title_only');
  } else if (!title && pageTitles.length) {
    assistReasons.push('title_unconfirmed');
  }

  const fragments = buildFragments({
    beisenApply,
    labeledCompanies,
    apply,
    jobCompanies,
    jobTitles,
    jobLocation: location,
    ogTitle,
    h1,
    documentTitle
  });

  const reliable = Boolean(company && title && !companyConflict && !titleConflict && !swapped);

  return {
    company,
    title,
    location,
    sourceUrl: redacted?.sourceUrl ?? '',
    dedupeUrl: redacted?.dedupeUrl ?? '',
    reliable,
    assistReasons,
    sources: {
      company: company
        ? { value: company, source: beisenApply && labeledCompanies.includes(company) ? 'beisen-company' : 'jobposting', reliable: true }
        : null,
      title: title
        ? { value: title, source: beisenApply && apply?.title === title ? 'beisen-apply-title' : 'jobposting', reliable: true }
        : null,
      location: location
        ? { value: location, source: 'jobposting', reliable: true }
        : null
    },
    fragments
  };
}

function buildFragments({ beisenApply, labeledCompanies, apply, jobCompanies, jobTitles, jobLocation, ogTitle, h1, documentTitle }) {
  const items = [];
  const push = (source, role, text) => {
    const value = collapse(text);
    if (!value || value.length > MAX_FRAGMENT_CHARS || FORM_LABEL.test(value)) return;
    if (PREFERENCE.test(value) || SENSITIVE.test(value) || value.includes('://')) return;
    if (items.some(item => item.source === source && item.text === value)) return;
    items.push({ source, role, text: value });
  };

  if (beisenApply) {
    for (const value of labeledCompanies) push('beisen-company', 'company', value);
    if (apply?.text) push('beisen-apply-title', 'job-title', apply.text);
  }
  for (const value of jobCompanies) push('jobposting-company', 'company', value);
  for (const value of jobTitles) push('jobposting-title', 'job-title', value);
  if (jobLocation) push('jobposting-location', 'job-location', jobLocation);
  push('og:title', 'page-title', ogTitle);
  push('h1', 'page-title', h1);
  push('document.title', 'page-title', documentTitle);

  return items.slice(0, MAX_FRAGMENTS).map((item, index) => ({ id: index + 1, ...item }));
}

function pageHost(href) {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isBeisenApplyHost(host) {
  return host === 'zhiye.com' || host.endsWith('.zhiye.com');
}

function findApplyPhrase(texts) {
  for (const value of texts) {
    const match = value.match(APPLY_PHRASE);
    const title = cleanField(match?.[1]);
    if (title && title.length <= MAX_FIELD_CHARS && !PREFERENCE.test(title)) {
      return { title, text: value };
    }
  }
  return null;
}

function companyLabels(doc, texts, apply) {
  const applyIndex = texts.indexOf(apply.text);
  // The employer heading precedes the apply summary. Company names in a later resume or
  // work-history section are not evidence about this posting's employer.
  const beforeApply = applyIndex < 0 ? [] : texts.slice(0, applyIndex);
  const fromElements = nodes(doc, COMPANY_SELECTOR)
    .map(node => cleanField(node?.textContent))
    .filter(value => isCompanyText(value) && beforeApply.includes(value));
  const companyLike = value => isCompanyText(value) && /公司$|集团$/.test(value);
  const pageTitle = cleanField(doc?.title);
  const titleCandidate = companyLike(pageTitle) ? [pageTitle] : [];
  const headingCandidates = beforeApply.map(cleanField).filter(companyLike);
  // An image alt can describe an avatar, navigation item or resume. It is never by itself
  // evidence of the employer, even when it is the only alt on the page.
  return unique([...fromElements, ...titleCandidate, ...headingCandidates]);
}

function isCompanyText(value) {
  return Boolean(value) && !APPLY_PHRASE.test(value) && !PREFERENCE.test(value) && !FORM_LABEL.test(value)
    && !SENSITIVE.test(value) && !value.includes('://');
}

function firstJobLocation(postings) {
  for (const posting of postings) {
    const value = cleanField(localityFrom(posting));
    if (value && value.length <= MAX_FIELD_CHARS && !PREFERENCE.test(value)) return value;
  }
  return '';
}

function shortTexts(doc) {
  const values = [];
  for (const node of nodes(doc, TEXT_SELECTOR)) {
    if (typeof node?.querySelector === 'function' && node.querySelector('input, textarea, select')) continue;
    const value = collapse(node?.textContent);
    if (!value || value.length > MAX_FRAGMENT_CHARS || FORM_LABEL.test(value)) continue;
    if (SENSITIVE.test(value) || value.includes('://')) continue;
    values.push(value);
  }
  return unique(values);
}

function findJobPostings(doc) {
  let nodesFound;
  try {
    nodesFound = doc.querySelectorAll('script[type="application/ld+json"]');
  } catch {
    return [];
  }
  const found = [];
  for (const node of nodesFound ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(node.textContent);
    } catch {
      continue;
    }
    collectPostings(parsed, found, 0);
  }
  return found;
}

function collectPostings(value, found, depth) {
  if (depth > 4 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectPostings(entry, found, depth + 1);
    return;
  }
  const type = value['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('JobPosting')) found.push(value);
  collectPostings(value['@graph'], found, depth + 1);
}

function companyFrom(posting) {
  const org = posting?.hiringOrganization;
  if (typeof org === 'string') return org;
  return org?.name;
}

function localityFrom(posting) {
  const location = Array.isArray(posting?.jobLocation) ? posting.jobLocation[0] : posting?.jobLocation;
  // addressLocality / addressRegion are the posting's workplace. Applicant preferences are
  // not on this object; a label that still says so is rejected by the caller.
  return location?.address?.addressLocality ?? location?.address?.addressRegion;
}

function heading(doc) {
  try {
    return cleanField(doc.querySelector('h1')?.textContent);
  } catch {
    return '';
  }
}

function metaContent(doc, property) {
  let node;
  try {
    node = doc.querySelector(`meta[property="${property}"]`);
  } catch {
    return '';
  }
  return cleanField(node?.getAttribute?.('content') ?? node?.content);
}

function nodes(doc, selector) {
  try {
    return [...(doc.querySelectorAll(selector) ?? [])];
  } catch {
    return [];
  }
}

function collapse(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function cleanField(value) {
  const cleaned = collapse(value);
  return cleaned.length > MAX_FIELD_CHARS ? '' : cleaned;
}

function unique(values) {
  return [...new Set(values)];
}
