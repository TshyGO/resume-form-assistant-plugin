import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';

type Reply = Record<string, unknown>;
// Mounts the real plugin feedback-ui.js (Chrome and Edge load the same file) with the same
// mount points as sidepanel.html or popup.html, against a scripted service worker.
function setup(failure = '', pathname = '/sidepanel.html') {
  document.body.innerHTML = pathname === '/sidepanel.html'
    ? '<button id="fill-button">一键 AI 填写</button><div id="feedback-notice-root" hidden></div><details id="fill-diagnostics"></details><div id="feedback-manual-root"></div><div id="feedback-auto-root" data-variant="compact"></div>'
    : '<div id="feedback-notice-root" hidden></div><div id="feedback-auto-root"></div><div id="feedback-manual-root"></div>';
  const calls: Record<string, unknown>[] = [];
  let consent = true;
  let noticeSeen = false;
  let now = 100000;
  let previews = 0;
  let updated: (id: number, change: { status: string }) => void = () => {};
  let held: ((value: Reply) => void) | null = null;
  const state = { hold: false, sendReply: null as Reply | null };
  const timers: (() => void)[] = [];
  class Clock extends Date { static override now() { return now; } }
  const api = {
    runtime: { sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      calls.push(message);
      if (message.type === 'FEEDBACK_STATUS') return failure === 'settings' ? { ok: false } : { consent, noticeSeen };
      if (message.type === 'FEEDBACK_CONSENT') { consent = message.enabled === true; noticeSeen = true; return { consent, noticeSeen }; }
      if (message.type === 'FEEDBACK_NOTICE_SEEN') { noticeSeen = true; return { consent, noticeSeen }; }
      if (message.type === 'FEEDBACK_PREVIEW') { previews++; return { ok: true, token: `draft-${previews}`, payload: { user_description: message.description, diagnostics: message.diagnostics, anonymous_id: 'test-id' } }; }
      const reply = state.sendReply || (failure ? { ok: false, reason: failure } : { ok: true, id: 'receipt-123' });
      if (state.hold) return new Promise<Reply>(resolve => { held = resolve; });
      return reply;
    }) },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ diagnostics: '网页字段：1；成功填写：0；没填上：1' }), onActivated: { addListener: () => {} }, onUpdated: { addListener: (listener: typeof updated) => { updated = listener; } } },
    storage: { onChanged: { addListener: () => {} } }
  };
  const context = vm.createContext({ document, chrome: api, self: {}, location: { pathname }, Date: Clock, setTimeout: (callback: () => void) => { timers.push(callback); return 0; } });
  vm.runInContext(readFileSync('../feedback-core.js', 'utf8'), context);
  vm.runInContext(readFileSync('../feedback-ui.js', 'utf8'), context);
  return {
    calls, state,
    sends: () => calls.filter(c => c.type === 'FEEDBACK_SEND'),
    release: (value: Reply) => { held?.(value); held = null; },
    updated: (id: number) => updated(id, { status: 'loading' }),
    finishCooldown: () => { now += 60001; timers.forEach(callback => callback()); }
  };
}
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const description = () => document.getElementById('feedback-description') as HTMLTextAreaElement;
const attach = () => document.getElementById('feedback-attach') as HTMLInputElement;
const form = () => document.getElementById('feedback-form') as HTMLFormElement;
const summary = () => document.getElementById('feedback-summary') as HTMLElement;
const preview = () => document.getElementById('feedback-preview') as HTMLPreElement;
const expand = () => document.getElementById('feedback-expand') as HTMLButtonElement;
async function previewDraft(text = '按钮没反应') {
  if (form().hidden) fireEvent.click(button('展开'));
  fireEvent.input(description(), { target: { value: text } });
  fireEvent.click(button('预览将发送的内容'));
  await waitFor(() => expect(button('确认发送').disabled).toBe(false));
}

// ---- first-use notice and the automatic preference ----

test('the notice explains both independent ways and sits after the fill button', async () => {
  setup();
  const notice = await screen.findByRole('region', { name: '错误报告与问题反馈' });
  const fill = button('一键 AI 填写');
  expect(fill.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const text = notice.textContent || '';
  expect(text).toMatch(/自动错误报告（默认开启）：插件检测到自身异常，或一键填写后有字段没填上时，自动发送一份脱敏诊断。关闭它不影响手动反馈问题。/);
  expect(text).toMatch(/手动反馈问题：由你填写描述，预览全部内容并确认后才发送。/);
  for (const disclosure of ['定位问题', '不上传简历', 'Cloudflare', '90 天', 'GitHub issue', '随机安装标识']) expect(text).toContain(disclosure);
  expect(text).toMatch(/「知道了」只收起本说明，不改变设置/);
  expect(within(notice).getByRole('button', { name: '关闭自动错误报告' })).toBeTruthy();
});

test('知道了 only folds the notice, and the full text can be reopened later without storing anything', async () => {
  const { calls } = setup();
  await screen.findByRole('button', { name: '知道了' });
  await screen.findByText('自动错误报告：已开启');
  fireEvent.click(button('知道了'));
  await waitFor(() => expect(screen.queryByRole('button', { name: '知道了' })).toBeNull());
  expect(calls.filter(c => c.type === 'FEEDBACK_NOTICE_SEEN')).toHaveLength(1);
  expect(calls.some(c => c.type === 'FEEDBACK_CONSENT')).toBe(false);
  expect(screen.getByText('自动错误报告：已开启')).toBeTruthy();
  fireEvent.click(button('查看完整说明'));
  const notice = await screen.findByRole('region', { name: '错误报告与问题反馈' });
  expect(notice.textContent).toContain('Cloudflare');
  fireEvent.click(within(notice).getByRole('button', { name: '知道了' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '错误报告与问题反馈' })).toBeNull());
  expect(calls.filter(c => c.type === 'FEEDBACK_NOTICE_SEEN')).toHaveLength(1);
});

test('turning automatic reports off from the notice leaves manual feedback working', async () => {
  const { calls, sends } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '关闭自动错误报告' }));
  await screen.findByText('自动错误报告：已关闭');
  expect(screen.queryByRole('button', { name: '知道了' })).toBeNull();
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toEqual([{ type: 'FEEDBACK_CONSENT', enabled: false }]);
  await screen.findByText(/手动反馈问题不受影响/);
  await previewDraft();
  fireEvent.click(button('确认发送'));
  await screen.findByText('发送成功，编号：receipt-123');
  expect(sends()).toEqual([{ type: 'FEEDBACK_SEND', token: 'draft-1' }]);
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toHaveLength(1);
  // The reopened notice offers the opposite action.
  fireEvent.click(button('查看完整说明'));
  fireEvent.click(await screen.findByRole('button', { name: '开启自动错误报告' }));
  await screen.findByText('自动错误报告：已开启');
  expect(screen.queryByRole('region', { name: '错误报告与问题反馈' })).toBeNull();
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT').at(-1)).toEqual({ type: 'FEEDBACK_CONSENT', enabled: true });
});

test('status page separates the automatic switch from manual feedback and neither changes the other', async () => {
  const { calls } = setup('', '/popup.html');
  const auto = screen.getByRole('region', { name: '自动错误报告' });
  const manual = screen.getByRole('region', { name: '手动反馈问题' });
  expect(auto.contains(manual) || manual.contains(auto)).toBe(false);
  const toggle = within(auto).getByRole('checkbox', { name: '开启自动错误报告' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  expect(manual.textContent).not.toMatch(/自动/);
  expect(within(auto).queryByRole('button', { name: /展开|确认发送/ })).toBeNull();
  fireEvent.click(within(manual).getByRole('button', { name: '展开' }));
  fireEvent.input(description(), { target: { value: '草稿' } });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  await within(auto).findByText('已关闭：不会自动发送任何报告。');
  expect(description().value).toBe('草稿');
  expect(form().hidden).toBe(false);
  expect(calls.some(c => c.type === 'FEEDBACK_PREVIEW' || c.type === 'FEEDBACK_SEND')).toBe(false);
});

test('plugin exposes a retry when reading consent fails', async () => {
  const { calls } = setup('settings');
  fireEvent.click(await screen.findByRole('button', { name: '重新读取设置' }));
  await screen.findByText('无法读取反馈设置，请重新读取。');
  expect(calls.filter(c => c.type === 'FEEDBACK_STATUS')).toHaveLength(2);
});

// ---- manual feedback: folding, success and failure ----

test('manual feedback starts folded and folding keeps the draft and its preview', async () => {
  setup();
  expect(form().hidden).toBe(true);
  expect(expand().getAttribute('aria-expanded')).toBe('false');
  expect(summary().textContent).toBe('由你填写描述、预览并确认后才发送。');
  await previewDraft('第二步没填上');
  fireEvent.click(button('收起'));
  expect(form().hidden).toBe(true);
  expect(expand().getAttribute('aria-expanded')).toBe('false');
  expect(summary().textContent).toBe('请核对预览，确认后发送。');
  fireEvent.click(button('展开'));
  expect(description().value).toBe('第二步没填上');
  expect(preview().hidden).toBe(false);
  expect(button('确认发送').disabled).toBe(false);
});

test('folding during a send neither cancels it nor sends again; a failure keeps the draft for a new preview', async () => {
  const { state, sends, release, finishCooldown } = setup();
  await previewDraft('上传按钮无效');
  fireEvent.click(attach());
  fireEvent.click(button('预览将发送的内容'));
  await waitFor(() => expect(button('确认发送').disabled).toBe(false));
  state.hold = true;
  fireEvent.click(button('确认发送'));
  await waitFor(() => expect(sends()).toHaveLength(1));
  fireEvent.click(button('收起'));
  expect(summary().textContent).toBe('正在发送…');
  release({ ok: false, reason: 'network' });
  await waitFor(() => expect(summary().textContent).toMatch(/发送失败，没有自动重试，草稿已保留/));
  expect(form().hidden).toBe(true);
  expect(sends()).toHaveLength(1);
  fireEvent.click(button('展开'));
  expect(description().value).toBe('上传按钮无效');
  expect(attach().checked).toBe(false);
  expect(preview().hidden).toBe(true);
  expect(button('确认发送').disabled).toBe(true);
  state.hold = false;
  fireEvent.input(description(), { target: { value: '上传按钮无效，补充：点击无反应' } });
  fireEvent.click(button('预览将发送的内容'));
  await screen.findByText('未附上填写诊断。请核对预览，确认后发送。');
  expect(button('确认发送').disabled).toBe(true);
  finishCooldown();
  expect(button('确认发送').disabled).toBe(false);
  fireEvent.click(button('确认发送'));
  await screen.findByText('发送成功，编号：receipt-123');
  expect(sends().map(c => c.token)).toEqual(['draft-2', 'draft-3']);
});

test('a successful send clears the draft, folds to a receipt, and the next report needs a new preview', async () => {
  const { sends, finishCooldown } = setup();
  await previewDraft('日期控件填错');
  fireEvent.click(attach());
  fireEvent.click(button('预览将发送的内容'));
  await waitFor(() => expect(button('确认发送').disabled).toBe(false));
  fireEvent.click(button('确认发送'));
  await screen.findByText('发送成功，编号：receipt-123');
  expect(form().hidden).toBe(true);
  expect(summary().textContent).toBe('发送成功，编号：receipt-123');
  expect(description().value).toBe('');
  expect(attach().checked).toBe(true);
  expect(preview().hidden).toBe(true);
  expect(preview().textContent).toBe('');
  fireEvent.click(button('展开'));
  expect(summary().textContent).toBe('');
  expect(screen.queryByText('发送成功，编号：receipt-123')).toBeNull();
  expect(button('确认发送').disabled).toBe(true);
  fireEvent.submit(form());
  expect(sends()).toHaveLength(1);
  fireEvent.click(button('预览将发送的内容'));
  await screen.findByText('请核对预览，确认后发送。');
  expect(button('确认发送').disabled).toBe(true);
  finishCooldown();
  expect(button('确认发送').disabled).toBe(false);
});

test('plugin invalidates edited previews and explains worker restart without a forced cooldown', async () => {
  const { sends } = setup('preview');
  await previewDraft();
  fireEvent.input(description(), { target: { value: 'changed' } });
  expect(button('确认发送').disabled).toBe(true);
  fireEvent.click(button('预览将发送的内容')); await waitFor(() => expect(button('确认发送').disabled).toBe(false));
  fireEvent.click(button('确认发送')); await screen.findByText(/后台已重启，草稿已保留/);
  expect(description().value).toBe('changed');
  fireEvent.click(button('预览将发送的内容'));
  await waitFor(() => expect(button('确认发送').disabled).toBe(false));
  expect(sends()).toHaveLength(1);
});

test('only navigation of the attached tab invalidates a preview', async () => {
  const { updated } = setup();
  await previewDraft();
  updated(2); expect(button('确认发送').disabled).toBe(false);
  updated(1); expect(button('确认发送').disabled).toBe(true);
});

test('popup explains unavailable diagnostics and keeps that checkbox disabled after sending', async () => {
  setup('', '/popup.html');
  fireEvent.click(button('展开'));
  const box = screen.getByRole('checkbox', { name: /请在侧栏附上填写诊断/ }) as HTMLInputElement;
  expect(box.checked).toBe(false); expect(box.disabled).toBe(true);
  await previewDraft();
  fireEvent.click(button('确认发送')); await screen.findByText('发送成功，编号：receipt-123');
  expect(box.checked).toBe(false); expect(box.disabled).toBe(true);
});
