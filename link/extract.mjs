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

// What a company or job name must not be. These come from class-name selectors that are
// wider than the text they hit: a logo, a menu item, an empty select, a counter.
const PLACEHOLDER = /^(?:请(?:选择|输入|填写|选)\S{0,6}|选择|未知|暂无|无|待定|其他|全部|更多|详情|null|undefined|n\/?a|none|loading\.*|-+|—+)$/i;
const NAV_OR_ACTION = /^(?:首页|主页|登录|登陆|注册|退出|退出登录|返回|提交|投递|申请|立即投递|立即申请|确认|确定|取消|保存|上传|上传简历|访问公司|访问官网|下一步|上一步|关闭|搜索|查看|查看详情|职位列表|职位|岗位|社会招聘|校园招聘|校招|社招|实习生招聘|实习招聘|全球招聘|global jobs|jobs|careers|我的简历|我的申请|我的投递|个人中心|关于我们|联系我们|帮助|english|中文|logo)$/i;
const ONLY_SYMBOLS = /^[\d\s\p{P}\p{S}_]+$/u;
// A name that reads as an organisation. A company line without this shape is a candidate
// for the desktop AI to look at, not something to accept on the strength of a class name.
const COMPANY_SUFFIX = /(?:有限责任公司|股份有限公司|有限公司|研究院|研究所|事务所|集团|公司|股份|银行|医院|大学|学院|工厂|inc\.?|ltd\.?|llc|corp\.?|co\.|gmbh)$/i;
// A "company" that ends like a job, or a "job" that ends like a company, is misread.
const LOOKS_LIKE_JOB = /(?:工程师|经理|专员|主管|总监|实习生|助理|顾问|管培生|岗位|职位|招聘)$/;
const LOOKS_LIKE_COMPANY = COMPANY_SUFFIX;
const COUNT_LIKE_NAME = /^(?:共|约)?\s*\d+\s*(?:家|个|条|家公司|个职位|条记录)?$/;

export function extractJobFields(doc, href) {
  const redacted = redactUrl(href);
  const host = pageHost(href);
  const postings = findJobPostings(doc);
  const texts = shortTexts(doc);

  const jobCompanies = unique(postings.map(companyFrom).map(cleanField).filter(plausibleCompanyName));
  const jobTitles = unique(postings.map(posting => cleanField(posting?.title)).filter(plausibleName));
  const jobLocation = firstJobLocation(postings);

  const apply = findApplyPhrase(texts);
  // Host and page type both have to match. A job list on the same host is not this form.
  const beisenApply = isBeisenApplyHost(host) && Boolean(apply);
  const labels = beisenApply ? companyLabels(doc, texts, apply) : { strong: [], weak: [], rejected: false };
  const labeledCompanies = [...labels.strong, ...labels.weak];

  // Clear evidence: a JobPosting, or a line that reads like an organisation. A plausible
  // line with no such shape is only used when nothing clearer exists, and then it is
  // shown for review but never treated as settled.
  const strongCompanies = unique([...labels.strong, ...jobCompanies]);
  const companyValues = strongCompanies.length ? strongCompanies : labels.weak;
  const companyIsWeak = !strongCompanies.length && companyValues.length > 0;
  const applyTitle = beisenApply && plausibleName(apply?.title) ? [apply.title] : [];
  const titleValues = [...applyTitle, ...jobTitles];

  const companyConflict = unique(companyValues).length > 1;
  const titleConflict = unique(titleValues).length > 1;
  const company = companyConflict ? '' : (companyValues[0] || '');
  const titleRaw = titleConflict ? '' : (titleValues[0] || '');
  const swapped = Boolean(company && titleRaw && company === titleRaw);
  const title = swapped ? '' : titleRaw;
  // Ends like an organisation: probably the employer read into the job field.
  const titleSuspicious = Boolean(title) && LOOKS_LIKE_COMPANY.test(title);
  const location = jobLocation && !PREFERENCE.test(jobLocation) ? jobLocation : '';

  const ogTitle = metaContent(doc, 'og:title');
  const h1 = heading(doc);
  const documentTitle = cleanField(doc?.title);
  const pageTitles = unique([ogTitle, h1, documentTitle].filter(Boolean));
  const siteName = metaContent(doc, 'og:site_name');

  const assistReasons = [];
  if (!company) assistReasons.push('missing_company');
  if (!title) assistReasons.push('missing_title');
  if (labels.rejected) assistReasons.push('company_implausible');
  if (companyIsWeak) assistReasons.push('company_weak_evidence');
  if (titleSuspicious) assistReasons.push('title_suspicious');
  if (swapped) assistReasons.push('swapped');
  if (companyConflict) assistReasons.push('company_conflict');
  if (titleConflict) assistReasons.push('title_conflict');
  if (!title && pageTitles.length && pageTitles.every(value => value === company || value === siteName)) {
    assistReasons.push('site_title_only');
  } else if (!title && pageTitles.length) {
    assistReasons.push('title_unconfirmed');
  }

  // Numbered page snippets. When this local result is unreliable, save-flow sends them to
  // the desktop's AI through job-extract.mjs; nothing else from the page goes along.
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

  const reliable = Boolean(company && title && !companyIsWeak && !titleSuspicious && !companyConflict && !titleConflict && !swapped);
  // reliable: both fields have clear evidence. uncertain: something was read but not
  // enough to trust. invalid: nothing usable, or the two fields are the same text.
  // Uncertain and invalid both go to the desktop AI; only reliable skips it.
  const confidence = reliable ? 'reliable' : ((company || title) && !swapped ? 'uncertain' : 'invalid');

  return {
    company,
    title,
    location,
    sourceUrl: redacted?.sourceUrl ?? '',
    dedupeUrl: redacted?.dedupeUrl ?? '',
    reliable,
    confidence,
    assistReasons,
    sources: {
      company: company
        ? { value: company, source: beisenApply && labeledCompanies.includes(company) ? 'beisen-company' : 'jobposting', reliable: !companyIsWeak }
        : null,
      title: title
        ? { value: title, source: beisenApply && apply?.title === title ? 'beisen-apply-title' : 'jobposting', reliable: !titleSuspicious }
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
  const seenBeforeApply = nodes(doc, COMPANY_SELECTOR)
    .filter(node => !isInterfaceNode(node))
    .map(node => cleanField(node?.textContent))
    .filter(value => value && beforeApply.includes(value));
  const fromElements = seenBeforeApply.filter(value => isCompanyText(value));
  const companyLike = value => isCompanyText(value) && hasNamedCompanySuffix(value);
  const pageTitle = cleanField(doc?.title);
  const titleCandidate = companyLike(pageTitle) ? [pageTitle] : [];
  const headingCandidates = beforeApply.map(cleanField).filter(companyLike);
  // An image alt can describe an avatar, navigation item or resume. It is never by itself
  // evidence of the employer, even when it is the only alt on the page.
  const strong = unique([...fromElements.filter(hasNamedCompanySuffix), ...titleCandidate, ...headingCandidates]);
  const weak = unique(fromElements.filter(value => !COMPANY_SUFFIX.test(value)));
  return { strong, weak, rejected: seenBeforeApply.length > fromElements.length && !strong.length && !weak.length };
}

// A name worth showing at all: not a lone character, a number, a placeholder, or a menu or
// button label. Says nothing about whether it is *this* posting's company or title.
function plausibleName(value) {
  const text = collapse(value);
  if (!text || [...text].length < 2) return false;
  return !ONLY_SYMBOLS.test(text) && !PLACEHOLDER.test(text) && !NAV_OR_ACTION.test(text);
}

function isCompanyText(value) {
  return Boolean(value) && plausibleName(value) && !LOOKS_LIKE_JOB.test(value)
    && !APPLY_PHRASE.test(value) && !PREFERENCE.test(value) && !FORM_LABEL.test(value)
    && !SENSITIVE.test(value) && !value.includes('://') && !COUNT_LIKE_NAME.test(value);
}

function plausibleCompanyName(value) {
  return isCompanyText(value) && (!COMPANY_SUFFIX.test(value) || hasNamedCompanySuffix(value));
}

// A suffix is evidence only when a real name remains after generic organisation words are
// removed. This rejects labels such as "公司", "集团有限公司" and "12 家公司".
function hasNamedCompanySuffix(value) {
  if (!COMPANY_SUFFIX.test(value)) return false;
  let stem = collapse(value);
  let previous;
  do {
    previous = stem;
    stem = collapse(stem.replace(COMPANY_SUFFIX, ''));
  } while (stem && stem !== previous && COMPANY_SUFFIX.test(stem));
  return plausibleName(stem) && !COUNT_LIKE_NAME.test(stem);
}

function isInterfaceNode(node) {
  const tag = String(node?.tagName || '').toLowerCase();
  if (['a', 'button', 'input', 'option', 'select', 'textarea', 'nav'].includes(tag)) return true;
  const role = String(node?.getAttribute?.('role') || '').toLowerCase();
  if (['button', 'link', 'menuitem', 'navigation', 'option'].includes(role)) return true;
  if (node?.getAttribute?.('aria-hidden') === 'true') return true;
  try {
    return Boolean(node?.closest?.('a,button,nav,[role="button"],[role="link"],[role="menuitem"],[role="navigation"],[aria-hidden="true"]'));
  } catch {
    return false;
  }
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
    if (isInterfaceNode(node)) continue;
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
