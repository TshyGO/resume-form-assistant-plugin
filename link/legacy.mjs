import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { payloadBodySha256, validateRequest } from './protocol/validate.mjs';

/**
 * One-time move of 0.4.0 plugin data into the desktop (#130 PR 5).
 *
 * The plugin sends a manifest and its parts, the user confirms on the desktop, and only an
 * `imported` answer lets the plugin delete its copy — and only the parts that went over.
 * Anything the desktop cannot take (an oversized template, the 26th template, a key the
 * desktop dropped) stays in the plugin where the status page can hand it back.
 *
 * Bodies are never persisted here: the AI part carries the API key. The manifest (digests
 * only) is, so a restarted service worker resends the same parts under the same importId.
 */

export const OLD_KEYS = ['templates', 'activeTemplateId', 'profile', 'aiConfig'];
export const STATE_KEY = 'legacyImport';
export const UNMIGRATED_KEY = 'legacyUnmigratedTemplates';
export const LEGACY_ALARM = 'resume-pro-legacy-import';

export const MAX_TEMPLATES = 25;
export const MAX_TEMPLATE_BYTES = 24 * 1024;
export const MAX_PROFILE_BYTES = 24 * 1024;
const MAX_NAME_CHARS = 100;
const ACTIVE_PHASES = new Set(['sending', 'waiting']);

const utf8Length = value => new TextEncoder().encode(JSON.stringify(value)).length;

function normalizeTemplate(template) {
  if (!template || typeof template !== 'object') return null;
  const groups = (Array.isArray(template.groups) ? template.groups : [])
    .map(group => {
      if (!group || typeof group !== 'object') return null;
      const fields = (Array.isArray(group.fields) ? group.fields : [])
        .map(field => field && typeof field === 'object'
          ? { key: String(field.key ?? '').trim(), value: String(field.value ?? '') }
          : null)
        .filter(field => field && field.key);
      return { name: String(group.name ?? '').trim() || '未分类', fields };
    })
    .filter(group => group && group.fields.length);
  const name = String(template.name ?? '').trim() || '未命名模板';
  return { id: typeof template.id === 'string' ? template.id : '', name, groups };
}

/**
 * What would go to the desktop, and what would not. Pure: the same stored data always
 * gives the same parts in the same order, so digests survive a service-worker restart.
 */
export function prepareLegacy(raw, profileApi) {
  const templates = (Array.isArray(raw?.templates) ? raw.templates : [])
    .map(normalizeTemplate)
    .filter(template => template && template.groups.length);
  const activeId = typeof raw?.activeTemplateId === 'string' ? raw.activeTemplateId : '';
  // The current template first, so a 26th template is never the one the user was using.
  const ordered = [
    ...templates.filter(template => template.id && template.id === activeId),
    ...templates.filter(template => !(template.id && template.id === activeId))
  ];

  const parts = [];
  const skippedTemplates = [];
  let sentTemplates = 0;
  for (const template of ordered) {
    if (utf8Length(template.groups) > MAX_TEMPLATE_BYTES) {
      skippedTemplates.push({ template, reason: 'too_large' });
      continue;
    }
    if (sentTemplates >= MAX_TEMPLATES) {
      skippedTemplates.push({ template, reason: 'over_limit' });
      continue;
    }
    sentTemplates += 1;
    parts.push({
      kind: 'template',
      body: {
        name: [...template.name].slice(0, MAX_NAME_CHARS).join(''),
        wasActive: Boolean(template.id && template.id === activeId),
        groups: template.groups
      }
    });
  }

  let profileSecrets = 0;
  let profileTooLarge = false;
  let profileSent = false;
  if (raw?.profile && profileApi.hasProfileContent(raw.profile)) {
    const { profile, removed } = profileApi.stripProfileSecrets(raw.profile);
    profileSecrets = removed;
    if (profileApi.hasProfileContent(profile)) {
      if (utf8Length(profile) > MAX_PROFILE_BYTES) {
        profileTooLarge = true;
      } else {
        parts.push({ kind: 'profile', body: profile });
        profileSent = true;
      }
    }
  }

  const ai = raw?.aiConfig && typeof raw.aiConfig === 'object' ? raw.aiConfig : null;
  const apiKey = String(ai?.apiKey ?? '').trim();
  const apiUrl = String(ai?.apiUrl ?? '').trim();
  const model = String(ai?.model ?? '').trim();
  const aiSent = Boolean(apiKey && apiUrl && model);
  if (aiSent) parts.push({ kind: 'aiConfig', body: { apiUrl, model, apiKey } });

  return {
    parts: parts.map((part, i) => ({ ...part, index: i + 1 })),
    sent: { templates: sentTemplates > 0, profile: profileSent, aiConfig: aiSent },
    skipped: { templates: skippedTemplates, profileSecrets, profileTooLarge },
    // A key without a usable address or model still belongs to the user; keep it.
    keepAiConfig: Boolean(apiKey) && !aiSent,
    hasData: parts.length > 0 || skippedTemplates.length > 0 || profileTooLarge
  };
}

/** RFC 4180 CSV with a BOM, the three columns the desktop 「简历」 page imports. */
export function templatesToCsv(templates) {
  const cell = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [['一级分类', '字段名', '值']];
  for (const template of templates) {
    for (const group of template.groups || []) {
      for (const field of group.fields || []) rows.push([group.name, field.key, field.value]);
    }
  }
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function createLegacy({ session, store, storage, sendNative, sleep, uuid, now, alarms, profileApi, getManifest, send = sendOnce }) {
  let running = null;

  async function readState() {
    const got = await storage.get([STATE_KEY]);
    return got[STATE_KEY] ?? null;
  }

  async function writeState(state) {
    const next = { ...state, updatedAt: now().toISOString() };
    await storage.set({ [STATE_KEY]: next });
    return next;
  }

  async function scheduleRetry() {
    await alarms?.create?.(LEGACY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }

  async function stopRetrying() {
    await alarms?.clear?.(LEGACY_ALARM);
  }

  // A request that cannot even be built (too large, rejected by the local validator) is a
  // verdict about this data, not a transient failure; report it like the desktop would.
  async function request(identity, payload) {
    try {
      return await sendRequest(identity, payload);
    } catch (error) {
      return { status: 'fatal', code: error?.code ?? 'invalid_payload', message: error?.message };
    }
  }

  async function sendRequest(identity, payload) {
    const envelope = await buildEnvelope({
      messageType: 'legacy.import',
      messageId: uuid(),
      clientInstanceId: await store.clientInstanceId(),
      payload,
      identity,
      now
    });
    await validateRequest(envelope);
    return send(envelope, { sendNative, sleep });
  }

  async function manifestFor(prepared) {
    return Promise.all(prepared.parts.map(async part => ({
      index: part.index, kind: part.kind, sha256: await payloadBodySha256(part.body)
    })));
  }

  async function startFresh(prepared, previous = null) {
    const parts = await manifestFor(prepared);
    return writeState({
      importId: uuid(),
      phase: 'sending',
      parts,
      sent: prepared.sent,
      keepAiConfig: prepared.keepAiConfig,
      skipped: {
        templates: prepared.skipped.templates.map(item => ({ name: item.template.name, reason: item.reason })),
        profileSecrets: prepared.skipped.profileSecrets,
        profileTooLarge: prepared.skipped.profileTooLarge
      },
      expiredRetries: previous?.expiredRetries ?? 0,
      error: null
    });
  }

  /** Remove exactly what the desktop now holds; park templates it could not take. */
  async function cleanUp(state, aiConfigDropped) {
    const raw = await storage.get(OLD_KEYS);
    const prepared = prepareLegacy(raw, profileApi);
    const unmigrated = prepared.skipped.templates.map(item => item.template);
    if (unmigrated.length) await storage.set({ [UNMIGRATED_KEY]: unmigrated });
    const drop = ['templates', 'activeTemplateId'];
    if (!prepared.skipped.profileTooLarge) drop.push('profile');
    const aiGone = state.sent?.aiConfig ? !aiConfigDropped : !state.keepAiConfig;
    if (aiGone) drop.push('aiConfig');
    await storage.remove(drop);
  }

  async function sendAll(state, identity) {
    const raw = await storage.get(OLD_KEYS);
    const prepared = prepareLegacy(raw, profileApi);
    const parts = await manifestFor(prepared);
    if (JSON.stringify(parts) !== JSON.stringify(state.parts)) {
      // The stored data changed since the manifest was made (another device synced, or a
      // restored backup). Starting over is safe: nothing was confirmed yet.
      state = await startFresh(prepared, state);
    }
    const manifest = {
      pluginVersion: String(getManifest?.().version || 'unknown'),
      total: state.parts.length,
      parts: state.parts
    };
    const first = await request(identity, { importId: state.importId, kind: 'manifest', index: 0, body: manifest });
    // A conflict on the manifest means another import is still open on the desktop: wait.
    if (first.status !== 'ok') return { state, result: first, waitable: first.code === 'conflict' };
    for (const part of prepared.parts) {
      const result = await request(identity, { importId: state.importId, kind: part.kind, index: part.index, body: part.body });
      if (result.status !== 'ok') return { state, result, waitable: false };
    }
    return { state: await writeState({ ...state, phase: 'waiting' }), result: { status: 'ok' } };
  }

  async function poll(state, identity) {
    const result = await request(identity, { importId: state.importId, kind: 'status' });
    if (result.status !== 'ok') return state;
    const status = result.response.payload;
    if (status.state === 'imported') {
      await cleanUp(state, Boolean(status.aiConfigDropped));
      await stopRetrying();
      return writeState({ ...state, phase: status.aiConfigDropped ? 'imported_ai_dropped' : 'imported' });
    }
    if (status.state === 'rejected') {
      await stopRetrying();
      return writeState({ ...state, phase: 'rejected' });
    }
    if (status.state === 'expired') {
      return writeState({ ...state, phase: 'expired', expiredRetries: (state.expiredRetries ?? 0) + 1 });
    }
    return writeState({ ...state, lastState: status.state });
  }

  async function step() {
    let state = await readState();
    if (state && !ACTIVE_PHASES.has(state.phase) && state.phase !== 'expired') return state;
    if (state?.phase === 'expired' && (state.expiredRetries ?? 0) > 1) {
      await stopRetrying();
      return state;
    }

    const raw = await storage.get(OLD_KEYS);
    const prepared = prepareLegacy(raw, profileApi);
    // No old data and nothing in flight: never start the native host for nothing.
    if (!state && !prepared.parts.length) return null;

    const probe = await session.probe();
    if (probe.mode !== 'ready') {
      if (state) await scheduleRetry();
      return state;
    }

    if (!state || state.phase === 'expired') {
      if (!prepared.parts.length) return state;
      state = await startFresh(prepared, state);
    }

    if (state.phase === 'sending') {
      const { state: next, result, waitable } = await sendAll(state, probe.identity);
      state = next;
      if (result.status !== 'ok') {
        // A verdict on the data itself does not change by asking again every minute (each
        // attempt starts the native host). Stop and let the status page explain.
        if (result.status === 'fatal' && !waitable) {
          await stopRetrying();
          return writeState({ ...state, phase: 'failed', error: result.message || '桌面不接受这批数据。' });
        }
        // Another import still open, or the desktop went away mid-send: resend later.
        await scheduleRetry();
        return state;
      }
      await scheduleRetry();
      await openResumeView();
    }

    return poll(state, probe.identity);
  }

  async function openResumeView() {
    try {
      const envelope = await buildEnvelope({
        messageType: 'ui.open',
        messageId: uuid(),
        clientInstanceId: await store.clientInstanceId(),
        payload: { view: 'resume' },
        identity: null,
        now
      });
      await validateRequest(envelope);
      await send(envelope, { sendNative, sleep });
    } catch {
      // Bringing the window forward is a convenience; the banner is there either way.
    }
  }

  /** Advance the migration once. Concurrent callers share the same run. */
  function run() {
    if (!running) {
      running = step().catch(() => readState()).finally(() => { running = null; });
    }
    return running;
  }

  /** Templates the desktop could not take, as full templates for the CSV download. */
  async function unmigratedTemplates() {
    const parked = (await storage.get([UNMIGRATED_KEY]))[UNMIGRATED_KEY];
    if (Array.isArray(parked)) return parked;
    // Not migrated yet (or nothing else to send): the same rule, read from the old data.
    const raw = await storage.get(OLD_KEYS);
    return prepareLegacy(raw, profileApi).skipped.templates.map(item => item.template);
  }

  async function status() {
    const state = await readState();
    const raw = await storage.get(['aiConfig']);
    return {
      phase: state?.phase ?? 'none',
      error: state?.error ?? null,
      skipped: state?.skipped ?? null,
      unmigratedTemplates: (await unmigratedTemplates()).length,
      hasOldKey: Boolean(String(raw.aiConfig?.apiKey ?? '').trim())
    };
  }

  /** The user asks to send again after rejecting, a failure, or two expiries. */
  async function resend() {
    const state = await readState();
    if (state && ACTIVE_PHASES.has(state.phase)) return run();
    const raw = await storage.get(OLD_KEYS);
    const prepared = prepareLegacy(raw, profileApi);
    if (!prepared.parts.length) return state;
    await startFresh(prepared, null);
    return run();
  }

  /** The user deletes what is left of the old data in the plugin. Confirmation is the caller's. */
  async function discard() {
    await storage.remove([...OLD_KEYS, UNMIGRATED_KEY]);
    await stopRetrying();
    const state = await readState();
    return writeState({ ...(state ?? {}), phase: 'discarded' });
  }

  async function dropOldKey() {
    await storage.remove(['aiConfig']);
    return status();
  }

  return { run, status, resend, discard, dropOldKey, unmigratedTemplates };
}
