import { MAX_INTENTS } from './limits.mjs';

// User-facing wording for every outcome of a save, in one table.
//
// The distinctions here are contractual, not stylistic. §9 requires that an uninstalled
// desktop is never described as unpaired and vice versa, and that queued work is never
// described as saved. Scattering these strings across the sidebar is how one of them
// eventually says the wrong thing.
const PAIRING_HINT = '粘贴后请重新加载扩展或重启浏览器，否则新的注册不会生效。';

export function describeSaveResult(result) {
  const { status, mode, reason, extensionId } = result ?? {};

  if (status === 'queued') {
    if (mode === 'incompatible') {
      return {
        tone: 'pending',
        text: '已记为待同步（尚未绑定申请）。桌面程序的协议版本和插件对不上，升级之后才能同步。'
      };
    }
    return {
      tone: 'pending',
      text: '已记为待同步（尚未绑定申请）。桌面程序可用之后再选择绑定到哪条申请。'
    };
  }

  if (status === 'duplicate') {
    return {
      tone: 'warn',
      offerForce: true,
      text: result.recent
        ? '刚刚已经存过这个岗位了，没有再存一份。'
        : '这个岗位已经在待同步列表里了，没有再存一份。',
      hint: '如果这是又投了一次，可以选择再存一次。'
    };
  }

  if (status === 'rejected') {
    if (reason === 'queue_full') {
      return {
        tone: 'warn',
        text: `待同步队列已满（${MAX_INTENTS} 条），这次没有保存。请先处理已有的几条。填表功能不受影响。`
      };
    }
    return { tone: 'warn', text: '公司和岗位不能为空，请补齐之后再保存。' };
  }

  if (status === 'not_queued') {
    if (mode === 'not_installed') {
      return {
        tone: 'info',
        text: '没有找到桌面程序，这次没有保存。装好之后再回来保存岗位；填表、模板和 AI 填写都不受影响。'
      };
    }
    if (mode === 'not_paired') {
      return {
        tone: 'info',
        extensionId,
        text: '桌面程序在运行，但还没有配对这个插件，这次没有保存。到桌面程序的设置里粘贴下面的扩展 ID。',
        hint: PAIRING_HINT
      };
    }
    return {
      tone: 'info',
      extensionId,
      text: '还没有和桌面程序配对过，这次没有保存。打开桌面程序，在设置里粘贴下面的扩展 ID。',
      hint: PAIRING_HINT
    };
  }

  return { tone: 'warn', text: '这次没能保存，请稍后再试。填表功能不受影响。' };
}
