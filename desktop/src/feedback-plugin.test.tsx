import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
function setup(failure = '') {
  document.body.innerHTML = '<div id="feedback-root"></div>';
  const calls: Record<string, unknown>[] = [];
  let consent: boolean | null = null;
  const api = {
    runtime: { sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      calls.push(message);
      if (message.type === 'FEEDBACK_STATUS') return failure === 'settings' ? { ok: false } : { consent };
      if (message.type === 'FEEDBACK_CONSENT') { consent = message.enabled === true; return { consent }; }
      if (message.type === 'FEEDBACK_PREVIEW') return { ok: true, token: 'draft', payload: { description: 'reviewed', anonymous_id: 'test-id' } };
      return failure ? { ok: false, reason: failure } : { ok: true, id: 'receipt-123' };
    }) },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ diagnostics: '网页字段：1；成功填写：0；没填上：1' }), onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    storage: { onChanged: { addListener: () => {} } }
  };
  const context = vm.createContext({ document, chrome: api, self: {}, location: { pathname: '/sidepanel.html' }, Date, setTimeout: () => 0 });
  vm.runInContext(readFileSync('../feedback-core.js', 'utf8'), context);
  vm.runInContext(readFileSync('../feedback-ui.js', 'utf8'), context);
  return calls;
}
test('plugin displays explicit choice, previews complete payload and sends only its token while opted out', async () => {
  const calls = setup(); fireEvent.click(await screen.findByRole('button', { name: '暂不' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '开启' })).toBeNull());
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
  const calls = setup('preview');
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
  const calls = setup('settings');
  fireEvent.click(await screen.findByRole('button', { name: '重新读取设置' }));
  await screen.findByText('无法读取反馈设置，请重新读取。');
  expect(calls.filter(c => c.type === 'FEEDBACK_STATUS')).toHaveLength(2);
});
