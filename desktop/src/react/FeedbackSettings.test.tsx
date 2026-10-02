import { expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Invoke } from "../api.ts";
import { FeedbackSettings } from "./FeedbackSettings.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { reportFrontendError, installFrontendErrors } from "../feedback.ts";
const draft = { token: 'preview-token', payload: { app: 'resume-form-assistant-desktop', user_description: '已清洗的描述', anonymous_id: 'random-test-id' } };
function mockInvoke(consent: boolean | null = null) {
  const fn = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'feedback_status') return { consent };
    if (name === 'feedback_consent') return { consent: args?.enabled === true };
    if (name === 'feedback_preview') return draft;
    return { ok: true, id: 'received-123' };
  });
  return { fn, invoke: fn as Invoke };
}
test('choice is explicit; manual sends only after complete preview and while opted out', async () => {
  const { invoke, fn } = mockInvoke(); render(<FeedbackSettings invoke={invoke} />);
  fireEvent.click(await screen.findByRole('button', { name: '暂不' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '开启' })).toBeNull());
  expect(fn).toHaveBeenCalledWith('feedback_consent', { enabled: false });
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/问题描述/), { target: { value: '按钮无法使用' } });
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  await screen.findByText(/random-test-id/);
  expect(fn.mock.calls.some(([name]) => name === 'feedback_send')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
  await screen.findByText('发送成功，编号：received-123');
  expect(fn).toHaveBeenCalledWith('feedback_send', { token: 'preview-token' });
  expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(true);
});
test('editing invalidates preview and a stale async response cannot enable sending', async () => {
  let finish: (value: unknown) => void = () => {};
  const invoke = vi.fn((name: string) => name === 'feedback_status' ? Promise.resolve({ consent: false }) : new Promise(resolve => { finish = resolve; })) as Invoke;
  render(<FeedbackSettings invoke={invoke} />);
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' }));
  fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  fireEvent.change(screen.getByLabelText(/问题描述/), { target: { value: '新描述' } });
  await act(async () => { finish(draft); });
  expect(screen.queryByText(/random-test-id/)).toBeNull();
  expect((screen.getByRole('button', { name: '确认发送' }) as HTMLButtonElement).disabled).toBe(true);
});
test('failed manual feedback is explicit and cannot resend without a new preview', async () => {
  const { invoke } = mockInvoke(false);
  const wrapped = vi.fn((name: string, args?: Record<string, unknown>) => name === 'feedback_send' ? Promise.resolve({ ok: false, reason: 'network' }) : invoke(name, args)) as Invoke;
  render(<FeedbackSettings invoke={wrapped} />);
  fireEvent.click(screen.getByRole('button', { name: '反馈问题' })); fireEvent.click(screen.getByRole('button', { name: '预览将发送的内容' }));
  await screen.findByText(/random-test-id/); fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
  await screen.findByText(/发送失败，没有自动重试/);
  expect(vi.mocked(wrapped).mock.calls.filter(([name]) => name === 'feedback_send')).toHaveLength(1);
});
test('window hooks and React boundary report only safe app frames without exception text', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const invoke = vi.fn(async () => {}) as Invoke;
  const error = new TypeError('姓名 张三 API response resume');
  error.stack = 'TypeError: secret\n at fn (tauri://localhost/assets/index-abc.js:12:3)\n at https://private.test/a:1:2';
  reportFrontendError(error, invoke);
  expect(invoke).toHaveBeenCalledWith('report_frontend_error', { error: { name: 'TypeError', stack: 'tauri://localhost/assets/index-abc.js:12:3' } });
  const target = new EventTarget() as Window; const cleanup = installFrontendErrors(invoke, target);
  target.dispatchEvent(new ErrorEvent('error', { error })); cleanup();
  const count = vi.mocked(invoke).mock.calls.length; target.dispatchEvent(new ErrorEvent('error', { error }));
  expect(vi.mocked(invoke).mock.calls.length).toBe(count);
  function Crash(): never { throw error; }
  render(<ErrorBoundary invoke={invoke}><Crash /></ErrorBoundary>);
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: '重新显示' })).toBeTruthy();
  expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toMatch(/张三|secret|private.test|API response/);
});

test('consent save failure stays visible in the choice card while privacy panel is hidden', async () => {
  const portal = document.createElement('div'); document.body.append(portal);
  const invoke = vi.fn((name: string) => name === 'feedback_status' ? Promise.resolve({ consent: null }) : Promise.reject(new Error('disk'))) as Invoke;
  const { unmount } = render(<div hidden><FeedbackSettings invoke={invoke} consentContainer={portal} /></div>);
  fireEvent.click(await within(portal).findByRole('button', { name: '开启' }));
  expect((await within(portal).findByRole('alert')).textContent).toBe('设置未能保存，请重试。');
  unmount(); portal.remove();
});
