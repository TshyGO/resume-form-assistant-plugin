import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';

type Reply = Record<string, unknown>;
// Mounts the real plugin feedback-ui.js (Chrome and Edge load the same file) with the same
// mount points as sidepanel.html or popup.html, against a scripted service worker.
function setup(failure = '', pathname = '/sidepanel.html', initial: { consent?: boolean; decided?: boolean } = {}) {
  document.body.innerHTML = pathname === '/sidepanel.html'
    ? '<button id="fill-button">一键 AI 填写</button><div id="feedback-notice-root" hidden></div><details id="fill-diagnostics"></details><div id="feedback-manual-root"></div><div id="feedback-auto-root" data-variant="compact"></div>'
    : '<div id="feedback-auto-root"></div>';
  const calls: Record<string, unknown>[] = [];
  // A new installation: nothing chosen, nothing sent.
  let consent = initial.consent ?? false;
  let decided = initial.decided ?? false;
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
      if (message.type === 'FEEDBACK_STATUS') return failure === 'settings' ? { ok: false } : { consent, decided };
      if (message.type === 'FEEDBACK_CONSENT') {
        if (failure === 'consent') return { ok: false, reason: 'unavailable' };
        consent = message.enabled === true; decided = true; return { consent, decided };
      }
      if (message.type === 'FEEDBACK_PREVIEW') { previews++; return { ok: true, token: `draft-${previews}`, payload: { user_description: message.description, diagnostics: message.diagnostics, anonymous_id: 'test-id' } }; }
      const reply = state.sendReply || (failure ? { ok: false, reason: failure } : { ok: true, id: 'receipt-123' });
      if (state.hold) return new Promise<Reply>(resolve => { held = resolve; });
      return reply;
    }) },
    // The page also returns the sidebar's human-readable text; only the v1 block (#215) is attached.
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ diagnostics: '网页字段：1；成功填写：0；没填上：1', diagnosticsReport: '[错误]\nerror_category: no_fields_found' }), onActivated: { addListener: () => {} }, onUpdated: { addListener: (listener: typeof updated) => { updated = listener; } } },
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

// ---- the choice and the automatic preference ----

const buttons = (root: HTMLElement) => within(root).queryAllByRole('button').map(b => b.textContent);
const NOTICE = '帮我们改进网申快填';
// What the explanation has to tell before anyone can agree (#247).
const DISCLOSURES = ['只有一句「填不上」', '随机生成的安装编号', '网站域名', '页面路径', '不包含你的简历', 'Cloudflare', '90 天', 'GitHub issue', '可能是公开的', '同意前出的错不会补发', '删除安装编号'];

test('the side-panel choice says why and what is sent, sits after the fill button and offers two plain answers', async () => {
  const { calls } = setup();
  const notice = await screen.findByRole('region', { name: NOTICE });
  const fill = button('一键 AI 填写');
  expect(fill.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const text = notice.textContent || '';
  for (const disclosure of DISCLOSURES) expect(text).toContain(disclosure);
  expect(text).toContain('遇到问题也可以在「手动反馈问题」里自己写，预览确认后才会发送。');
  expect(text).toContain('以后可以到「插件状态」更改。');
  expect(buttons(notice)).toEqual(['同意并开启', '暂不开启']);
  // The explanation comes before the buttons that answer it; showing it is not an answer.
  const why = within(notice).getByText(/只有一句「填不上」/);
  expect(why.compareDocumentPosition(button('同意并开启')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('自动错误报告：未开启（在「插件状态」中设置）')).toBeTruthy();
  expect(calls.some(c => c.type === 'FEEDBACK_CONSENT')).toBe(false);
});

test('同意并开启 is the only way the side panel turns reports on', async () => {
  const { calls } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '同意并开启' }));
  await screen.findByText('自动错误报告：已开启（在「插件状态」中设置）');
  expect(screen.queryByRole('region', { name: NOTICE })).toBeNull();
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toEqual([{ type: 'FEEDBACK_CONSENT', enabled: true }]);
  await screen.findByText('已开启自动错误报告，谢谢。');
  expect(screen.queryByRole('button', { name: /查看完整说明|收起说明/ })).toBeNull();
});

test('暂不开启 records the answer and leaves manual feedback working', async () => {
  const { calls, sends } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '暂不开启' }));
  await screen.findByText('自动错误报告：已关闭（在「插件状态」中设置）');
  expect(screen.queryByRole('region', { name: NOTICE })).toBeNull();
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toEqual([{ type: 'FEEDBACK_CONSENT', enabled: false }]);
  await screen.findByText(/手动反馈问题不受影响/);
  await previewDraft();
  fireEvent.click(button('确认发送'));
  await screen.findByText('发送成功，编号：receipt-123');
  expect(sends()).toEqual([{ type: 'FEEDBACK_SEND', token: 'draft-1' }]);
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toHaveLength(1);
});

test('a failed save keeps the choice on screen; an unanswered choice comes back with the next side panel', async () => {
  setup('consent');
  fireEvent.click(await screen.findByRole('button', { name: '同意并开启' }));
  await screen.findByText('设置未保存，请重试。');
  expect(screen.getByRole('region', { name: NOTICE })).toBeTruthy();
  expect(button('同意并开启').disabled).toBe(false);
  expect(screen.getByText('自动错误报告：未开启（在「插件状态」中设置）')).toBeTruthy();
  setup();
  expect(await screen.findByRole('region', { name: NOTICE })).toBeTruthy();
});

test('a failed save on the status page puts the switch back', async () => {
  setup('consent', '/popup.html', { consent: true, decided: true });
  const toggle = await screen.findByRole('checkbox', { name: '开启自动错误报告' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(toggle);
  await screen.findByText('设置未保存，请重试。');
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(false);
});

test('a side panel opened after the choice was made shows only the state line', async () => {
  setup('', '/sidepanel.html', { consent: false, decided: true });
  await screen.findByText('自动错误报告：已关闭（在「插件状态」中设置）');
  expect(screen.queryByRole('region', { name: NOTICE })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /自动错误报告/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /说明/ })).toBeNull();
});

test('while undecided the status page keeps the explanation open with the same two answers', async () => {
  const { calls } = setup('', '/popup.html');
  const auto = screen.getByRole('region', { name: '自动错误报告' });
  const details = await within(auto).findByRole('region', { name: '完整说明' });
  expect(screen.queryByRole('region', { name: NOTICE })).toBeNull();
  expect(auto.contains(details)).toBe(true);
  const text = details.textContent || '';
  for (const disclosure of DISCLOSURES) expect(text).toContain(disclosure);
  expect(text).toContain('遇到问题也可以在侧栏的「手动反馈问题」里自己写，预览确认后才会发送。');
  await within(auto).findByText('未开启：你选择之前不会自动发送任何报告。');
  const toggle = within(auto).getByRole('checkbox', { name: '开启自动错误报告' }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(buttons(auto)).toEqual(['同意并开启', '暂不开启']);
  fireEvent.click(within(auto).getByRole('button', { name: '同意并开启' }));
  await within(auto).findByText('已开启：插件检测到自身异常或字段没填上时，会自动发送脱敏诊断。');
  await waitFor(() => expect(within(auto).queryByRole('region', { name: '完整说明' })).toBeNull());
  expect(toggle.checked).toBe(true);
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toEqual([{ type: 'FEEDBACK_CONSENT', enabled: true }]);
  expect(buttons(auto)).toEqual(['查看完整说明']);
});

test('choosing with the switch while undecided keeps the explanation open', async () => {
  const { calls } = setup('', '/popup.html');
  const auto = screen.getByRole('region', { name: '自动错误报告' });
  await within(auto).findByRole('button', { name: '同意并开启' });
  fireEvent.click(within(auto).getByRole('checkbox', { name: '开启自动错误报告' }));
  await within(auto).findByText('已开启：插件检测到自身异常或字段没填上时，会自动发送脱敏诊断。');
  expect(within(auto).getByRole('region', { name: '完整说明' })).toBeTruthy();
  expect(buttons(auto)).toEqual(['收起说明']);
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT')).toEqual([{ type: 'FEEDBACK_CONSENT', enabled: true }]);
});

test('查看完整说明 expands the same card and 收起说明 folds it, with no second switch', async () => {
  const { calls } = setup('', '/popup.html', { consent: true, decided: true });
  const auto = screen.getByRole('region', { name: '自动错误报告' });
  const about = await within(auto).findByRole('button', { name: '查看完整说明' });
  expect(about.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(about);
  const details = within(auto).getByRole('region', { name: '完整说明' });
  expect(about.textContent).toBe('收起说明');
  expect(about.getAttribute('aria-expanded')).toBe('true');
  expect(details.textContent).toContain('如需开启或关闭，勾选或取消勾选上方「开启自动错误报告」即可。');
  expect(buttons(auto)).toEqual(['收起说明']);
  expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['收起说明']);
  // Changing the switch while reading keeps the explanation open.
  const toggle = within(auto).getByRole('checkbox', { name: '开启自动错误报告' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(toggle);
  await within(auto).findByText('已关闭：不会自动发送任何报告。');
  expect(within(auto).getByRole('region', { name: '完整说明' })).toBeTruthy();
  fireEvent.click(about);
  expect(within(auto).queryByRole('region', { name: '完整说明' })).toBeNull();
  expect(about.textContent).toBe('查看完整说明');
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT').map(c => c.enabled)).toEqual([false]);
});

test('the status page has the automatic switch only, with no manual feedback', async () => {
  const { calls } = setup('', '/popup.html', { consent: true, decided: true });
  const auto = screen.getByRole('region', { name: '自动错误报告' });
  expect(screen.queryByRole('region', { name: '手动反馈问题' })).toBeNull();
  expect(screen.queryByRole('region', { name: NOTICE })).toBeNull();
  for (const name of ['展开', '预览将发送的内容', '确认发送']) expect(screen.queryByRole('button', { name })).toBeNull();
  expect(auto.textContent).toContain('不影响侧栏里的「手动反馈问题」');
  const toggle = within(auto).getByRole('checkbox', { name: '开启自动错误报告' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(toggle);
  await within(auto).findByText('已关闭：不会自动发送任何报告。');
  fireEvent.click(toggle);
  await within(auto).findByText('已开启：插件检测到自身异常或字段没填上时，会自动发送脱敏诊断。');
  expect(toggle.checked).toBe(true);
  expect(calls.filter(c => c.type === 'FEEDBACK_CONSENT').map(c => c.enabled)).toEqual([false, true]);
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
  expect(preview().textContent).toContain('error_category: no_fields_found');
  expect(preview().textContent).not.toContain('网页字段');
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
