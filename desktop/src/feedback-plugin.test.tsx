import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
function setup(failure = '', pathname = '/sidepanel.html') {
  document.body.innerHTML = '<div id="feedback-root"></div>';
  const calls: Record<string, unknown>[] = [];
  let consent = true;
  let noticeSeen = false;
  let now = 100000;
  let updated: (id: number, change: { status: string }) => void = () => {};
  const timers: (() => void)[] = [];
  class Clock extends Date { static override now() { return now; } }
  const api = {
    runtime: { sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      calls.push(message);
      if (message.type === 'FEEDBACK_STATUS') return failure === 'settings' ? { ok: false } : { consent, noticeSeen };
      if (message.type === 'FEEDBACK_CONSENT') { consent = message.enabled === true; noticeSeen = true; return { consent, noticeSeen }; }
      if (message.type === 'FEEDBACK_NOTICE_SEEN') { noticeSeen = true; return { consent, noticeSeen }; }
      if (message.type === 'FEEDBACK_PREVIEW') return { ok: true, token: 'draft', payload: { description: 'reviewed', anonymous_id: 'test-id' } };
      return failure ? { ok: false, reason: failure } : { ok: true, id: 'receipt-123' };
    }) },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ diagnostics: '网页字段：1；成功填写：0；没填上：1' }), onActivated: { addListener: () => {} }, onUpdated: { addListener: (listener: typeof updated) => { updated = listener; } } },
    storage: { onChanged: { addListener: () => {} } }
  };
  const context = vm.createContext({ document, chrome: api, self: {}, location: { pathname }, Date: Clock, setTimeout: (callback: () => void) => { timers.push(callback); return 0; } });
  vm.runInContext(readFileSync('../feedback-core.js', 'utf8'), context);
  vm.runInContext(readFileSync('../feedback-ui.js', 'utf8'), context);
  return { calls, updated: (id: number) => updated(id, { status: 'loading' }), finishCooldown: () => { now += 60001; timers.forEach(callback => callback()); } };
}
test('plugin displays default-on notice, previews complete payload and sends only its token while opted out', async () => {
  const { calls } = setup(); fireEvent.click(await screen.findByRole('button', { name: '关闭自动上报' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '知道了' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(false));
  expect(calls.some(c => c.type === 'FEEDBACK_SEND')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
  await screen.findByText('发送成功，编号：receipt-123');
  expect(calls.filter(c => c.type === 'FEEDBACK_SEND')).toEqual([{ type: 'FEEDBACK_SEND', token: 'draft' }]);
  expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(true);
});
test('plugin invalidates edited previews and explains worker restart without a forced cooldown', async () => {
  const { calls } = setup('preview');
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' })); await waitFor(() => expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.input(screen.getByRole('textbox'), { target: { value: 'changed' } });
  expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' })); await waitFor(() => expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '确认发送' })); await screen.findByText(/后台已重启/);
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(false));
  expect(calls.filter(c => c.type === 'FEEDBACK_SEND')).toHaveLength(1);
});
test('plugin exposes a retry when reading consent fails', async () => {
  const { calls } = setup('settings');
  fireEvent.click(await screen.findByRole('button', { name: '重新读取设置' }));
  await screen.findByText('无法读取反馈设置，请重新读取。');
  expect(calls.filter(c => c.type === 'FEEDBACK_STATUS')).toHaveLength(2);
});

test('only navigation of the attached tab invalidates a preview', async () => {
  const { updated } = setup();
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  const send = screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  updated(2); expect(send.disabled).toBe(false);
  updated(1); expect(send.disabled).toBe(true);
});
test('popup explains unavailable diagnostics and keeps that checkbox disabled after sending', async () => {
  setup('', '/popup.html');
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  const attach = screen.getByRole('checkbox', { name: /请在侧栏附上填写诊断/ }) as HTMLInputElement;
  expect(attach.checked).toBe(false); expect(attach.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  const send = screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send); await screen.findByText('发送成功，编号：receipt-123');
  expect(attach.disabled).toBe(true);
});
test('a preview prepared during cooldown becomes sendable when the existing timer finishes', async () => {
  const { finishCooldown } = setup();
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  const preview = screen.getByRole('button', { name: '预览将发送的内容' });
  const send = screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement;
  fireEvent.click(preview); await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send); await screen.findByText('发送成功，编号：receipt-123');
  fireEvent.click(preview); await screen.findByText('请核对预览，确认后发送。');
  expect(send.disabled).toBe(true);
  finishCooldown(); expect(send.disabled).toBe(false);
});


test('plugin notice acknowledgement keeps reporting enabled without changing its preference', async () => {
  const { calls } = setup();
  const toggle = await screen.findByRole('checkbox', { name: '自动发送匿名错误报告' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '知道了' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '知道了' })).toBeNull());
  expect(toggle.checked).toBe(true);
  expect(calls.some(c => c.type === 'FEEDBACK_NOTICE_SEEN')).toBe(true);
  expect(calls.some(c => c.type === 'FEEDBACK_CONSENT')).toBe(false);
});
