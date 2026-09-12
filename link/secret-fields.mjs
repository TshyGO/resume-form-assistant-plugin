// @ts-check
// 密码 / 验证码 / 密钥这类字段的判定与剔除，外加地址里的凭据参数。快照要用，
// 弹窗导出备份也要用，规则只能有一份，所以集中放在这里。
//
// popup.js 是普通脚本，import 不进来；popup.html 把本文件当 module 加载，靠文件末尾
// 那一句把函数交给它。其他地方照常 import。
import { redactUrlCredentials } from './redact.mjs';

export { redactUrlCredentials };

// data-privacy §4.1 lists what may never reach a snapshot, and says the desktop copy has to
// strip once more even though the fill path already skips password inputs: a template is a
// spreadsheet the user typed, and nothing stops a row called "登录密码". Chinese labels are
// matched anywhere in the name; the English words only as whole words, so "Photo" and
// "Hotpot" are not mistaken for "otp". camelCase names are split first, so "apiKey" and
// "accessToken" are words too, and plurals ("API Keys") count. A group with such a name
// ("API Keys" holding "OpenAI": "…") loses every field in it. When in doubt the field is
// dropped, never kept "to see".
const SECRET_CJK = /(密码|口令|验证码|校验码|授权码|密钥|私钥|令牌)/u;
const SECRET_LATIN = /(?:^|[^a-z])(password|passwd|pwd|otp|api[\s_-]?key|token|cookie|secret)s?(?:[^a-z]|$)/iu;

// A field whose whole name is "Authorization" is an HTTP header someone pasted into a
// spreadsheet, and data-privacy §4.1 excludes the header and its value. Matching it as a
// substring would eat "Work Authorization", a real question on US applications whose
// answer is "Yes" — so only the exact name counts.
const SECRET_EXACT = new Set(['authorization', 'auth', 'proxy authorization', '认证头', '授权头']);

/** @param {unknown} name */
export function isSecretFieldName(name) {
  const text = String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  if (SECRET_EXACT.has(text.trim().toLowerCase())) return true;
  return SECRET_CJK.test(text) || SECRET_LATIN.test(text);
}

// The name is not the only way in: an imported template can carry a credential under "备注".
// These match a credential's shape — a labelled secret ("password: …"), a bearer header, a
// secret-bearing URL parameter, or a well-known key format — not the words alone, so a
// summary that says "熟悉 API Key 管理" stays.
const SECRET_VALUES = [
  /(?:^|[^a-z])(password|passwd|pwd|passcode|otp|api[\s_-]?key|(?:access|refresh|auth)?[\s_-]?token|secret|cookie|authorization)\s*[:=：]\s*\S/iu,
  /(密码|口令|验证码|校验码|授权码|密钥|令牌)\s*[:=：]\s*\S/u,
  /\bbearer\s+[a-z0-9._~+/=-]{16,}/iu,
  /[?&#](?:access_token|refresh_token|id_token|token|api_?key|key|secret|password|sig|signature|auth|code|ticket)=[^&#\s]+/iu,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{16,}/iu,
  /\bgh[pousr]_[a-z0-9]{20,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/iu
];

/** @param {unknown} value */
export function isSecretFieldValue(value) {
  const text = String(value ?? '');
  return SECRET_VALUES.some(pattern => pattern.test(text));
}

// The groups and fields an export keeps: blank keys and secret-looking fields are dropped.
/** @param {{ name?: unknown, groups?: unknown } | null | undefined} template */
export function stripSecretFields(template) {
  let omittedFieldCount = 0;
  const groups = [];

  for (const group of Array.isArray(template?.groups) ? template.groups : []) {
    const fields = [];
    const secretGroup = isSecretFieldName(group?.name);
    for (const field of Array.isArray(group?.fields) ? group.fields : []) {
      const key = String(field?.key ?? '').trim();
      if (!key) continue;
      const value = String(field?.value ?? '');
      if (secretGroup || isSecretFieldName(key) || isSecretFieldValue(value)) {
        omittedFieldCount += 1;
        continue;
      }
      fields.push({ key, value });
    }
    if (fields.length) groups.push({ name: String(group?.name ?? '').trim() || '未分类', fields });
  }

  return { groups, omittedFieldCount };
}

if (typeof self !== 'undefined') {
  /** @type {any} */ (self).ResumeProSecretFields = {
    isSecretFieldName,
    isSecretFieldValue,
    redactUrlCredentials,
    stripSecretFields
  };
}
