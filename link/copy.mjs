import { MAX_INTENTS, MAX_OUTBOX } from './limits.mjs';

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

// Why a write was refused, in words that mean something to the person who clicked. The
// protocol code is kept out of the sentence: it is not the user's vocabulary, and several
// of these codes mean "someone has to look at this", not "try again".
const REFUSALS = {
  previously_purged: '这条申请在桌面上已经被永久删除了，不会重建。如果还需要，请在桌面新建一条。',
  conflict: '桌面上有一条同样身份但内容不同的记录，没有自动处理。请到桌面核对之后再决定。',
  restore_epoch_mismatch: '桌面的档案库换过了，这条要先对账才能继续，已经暂停。',
  invalid_payload: '桌面看不懂这次的内容，没有保存。请检查公司和岗位是否填对。',
  identity_not_allowed: '桌面还没有配对这个插件，这次没有保存。',
  protocol_incompatible: '桌面程序的版本和插件对不上，升级之后再试。'
};

export function describeBindResult(result) {
  const { status, code, reason } = result ?? {};

  if (status === 'saved') {
    // The only sentence in the whole plugin that may claim the desktop has it, and it only
    // runs after a persisted reply. Saving a posting is not applying to it.
    return {
      tone: 'success',
      text: '桌面已保存（已收藏，不是已投递）。确认投递之后再点「确认已投递」。'
    };
  }

  if (status === 'pending') {
    return {
      tone: 'pending',
      text: '已经排进待同步队列，桌面可用之后会自动重试。现在还没有保存到桌面。'
    };
  }

  if (status === 'duplicate') {
    // The first click did the work. Saying "failed" here would send the user looking for a
    // problem that does not exist.
    return { tone: 'pending', text: '这条已经在待同步队列里了，没有重复排一份。' };
  }

  if (status === 'rejected') {
    if (reason === 'queue_full') {
      return {
        tone: 'warn',
        text: `待同步的消息已满（${MAX_OUTBOX} 条），这次没有绑定。请先处理已有的几条。填表功能不受影响。`
      };
    }
    if (reason === 'unknown_intent') {
      return { tone: 'warn', text: '这条待同步记录已经不在了，请重新保存一次。' };
    }
    if (reason === 'awaiting_reconcile' || reason === 'not_paused') {
      // Not "try later": this entry is waiting on a decision only the user can make, and
      // telling them to retry sends them round a loop that cannot succeed.
      return {
        tone: 'warn',
        text: '桌面换过档案库，这条不能直接重试，要先对账。请选择关联到已有申请、另存为新的，或者丢弃。'
      };
    }
    return { tone: 'warn', text: '这次没能绑定，请稍后再试。填表功能不受影响。' };
  }

  if (status === 'failed') {
    return { tone: 'warn', text: REFUSALS[code] ?? '桌面拒绝了这次写入，请到桌面核对。' };
  }

  return { tone: 'warn', text: '这次没能保存到桌面，已经留在待同步里。' };
}

// What the four unresolved reconcile answers mean, and why none of them is a retry button.
//
// After a restore the queued envelope carries an epoch the desktop has replaced. Sending it
// again is refused; sending it under the new epoch would be a different write the user never
// asked for. So every one of these ends in a choice the user makes.
const RECONCILE = {
  purged: '这条在桌面上已经被永久删除了。桌面不会重建它。',
  not_found: '当前档案库里没有找到这次写入的凭据。这不等于没有执行过——可能只是这份备份不含它。请先到桌面核对。',
  conflict: '桌面上有一条身份相同但内容不同的记录，没有自动处理。',
  unverifiable: '桌面无法核实这次写入是否发生过，不会自动重放。'
};

export function describeReconcileStatus(status) {
  return {
    tone: 'warn',
    text: RECONCILE[status] ?? '桌面换过档案库，这条要你决定怎么处理。',
    choices: ['associate', 'discard', 'resave']
  };
}
