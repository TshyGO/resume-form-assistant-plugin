import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';

/** Read and update the desktop-owned resume without caching a plugin copy. */
export function createResume({ session, store, sendNative, sleep, uuid, now, send = sendOnce }) {
  async function request(messageType, payload) {
    const probe = await session.probe();
    if (probe.mode !== 'ready') return { status: probe.mode };
    try {
      const envelope = await buildEnvelope({
        messageType,
        messageId: uuid(),
        clientInstanceId: await store.clientInstanceId(),
        payload,
        identity: probe.identity,
        now
      });
      const result = await send(envelope, { sendNative, sleep });
      if (result.status === 'ok') return { status: 'ok', data: result.response.payload };
      if (result.status === 'fatal') return { status: result.code ?? 'unavailable' };
      if (result.status === 'not_installed' || result.status === 'not_paired') return { status: result.status };
      return { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async function read() { return request('resume.read', {}); }

  async function setActiveTemplate(templateId) {
    const result = await request('resume.update', { op: 'setActiveTemplate', templateId });
    return result.status === 'invalid_payload' ? { status: 'missing_template' } : result;
  }

  async function saveProfile(profile, expectedRevision) {
    const result = await request('resume.update', { op: 'saveProfile', profile, expectedRevision });
    return result.status === 'secret_forbidden' ? { status: 'secret' } : result;
  }

  async function openView(view) {
    const result = await request('ui.open', { view });
    return result.status === 'ok' ? { status: 'ok', opened: result.data.opened } : result;
  }

  return { read, setActiveTemplate, saveProfile, openView };
}
