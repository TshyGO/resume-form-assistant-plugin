import { MAX_FILL_RECORDS, MAX_INTENTS, MAX_OUTBOX, MAX_STAGED_SNAPSHOTS } from './limits.mjs';

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

export function describeConfirmResult(result) {
  if (result?.status === 'saved') {
    return { tone: 'success', text: '已投递：桌面上的阶段已经更新。' };
  }
  if (result?.status === 'rejected' && result.reason === 'no_application') {
    return { tone: 'warn', text: '请先选择这次投递对应的申请。' };
  }
  // Everything else is still in the queue. Saying anything about the stage here would be a
  // claim about the desktop's records that nothing has confirmed.
  return { tone: 'pending', text: '已排进待同步队列，桌面可用之后会更新阶段。' };
}

// --- D08: archiving a fill ------------------------------------------------------------
//
// Two things these sentences must never do: say the desktop has the record before a
// persisted reply, and say anything about submitting. A completed fill is not a submission
// (rule 1), and not even "not submitted" is said here, so the word cannot drift into a claim.

const FILL_OUTCOMES = {
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
};

/** One line describing a finished fill: counts of fields written into the page. */
export function describeFillSummary(fill) {
  const outcome = FILL_OUTCOMES[fill?.outcome] ?? '结束';
  const written = `已写入网页 ${fill?.filledCount ?? 0}/${fill?.fieldCount ?? 0} 项`;
  const unconfirmed = fill?.unconfirmedCount ? `，${fill.unconfirmedCount} 项未确认` : '';
  return `这次填写${outcome}：${written}${unconfirmed}。`;
}

/** The card shown after a fill: what happened, and the question. */
export function describeFillOffer(fill) {
  return `${describeFillSummary(fill)}要把这次填写留档到桌面吗？留档记的是结果和计数，不记网页上填了什么。`;
}

// Why a fill was archived without its snapshot. The fill record itself is unaffected: a
// snapshot is an attachment, and losing it never costs the user the record or the fill.
const SNAPSHOT_ISSUES = {
  too_large: '简历快照超过 2 MiB，这次没有附上；填写记录照常留档。',
  empty: '模板里没有可以保存的字段，这次没有附上简历快照。',
  staging_full: `暂存的简历快照已满（${MAX_STAGED_SNAPSHOTS} 份 / 20 MiB），这次没有附上。请先处理待同步里的旧留档。`,
  staging_unavailable: '浏览器存储暂时不可用，这次没有附上简历快照；填写记录照常留档。',
  bytes_lost: '暂存的简历快照已经丢失，这次只留档填写记录。',
  queue_full: `待同步的消息已满（${MAX_OUTBOX} 条），简历快照这次没有排上。`
};

export function describeFillRecordResult(result) {
  const copy = describeFillRecordStatus(result);
  const extra = [];
  if (result?.status === 'saved' && result.uploadQueued) {
    extra.push('简历快照正在后台上传，传完之前本机会保留一份。');
  }
  if (result?.snapshotIssue && SNAPSHOT_ISSUES[result.snapshotIssue]) {
    extra.push(SNAPSHOT_ISSUES[result.snapshotIssue]);
  }
  return extra.length ? { ...copy, text: `${copy.text}${extra.join('')}` } : copy;
}

function describeFillRecordStatus(result) {
  const { status, mode, reason, code } = result ?? {};

  if (status === 'saved') {
    // The only sentence that may say the desktop holds the record, and it runs only after a
    // persisted reply.
    return { tone: 'success', text: '已留档到桌面：这次填写的结果记在所选申请下。' };
  }

  if (status === 'recorded') {
    if (mode === 'incompatible') {
      return {
        tone: 'pending',
        text: '已记为待同步（尚未选择申请）。桌面程序的协议版本和插件对不上，升级之后才能留档。'
      };
    }
    return {
      tone: 'pending',
      text: '已记为待同步（尚未选择申请）。桌面程序可用之后，在「待同步」里选择这次填写属于哪条申请。'
    };
  }

  if (status === 'pending') {
    return { tone: 'pending', text: '已排进待同步队列，桌面可用之后会自动发送。现在还没有留档到桌面。' };
  }

  if (status === 'duplicate') {
    return { tone: 'pending', text: '这次填写已经在待同步队列里了，没有重复排一份。' };
  }

  if (status === 'rejected') {
    if (reason === 'queue_full') {
      return {
        tone: 'warn',
        text: `待同步的留档已满（${MAX_FILL_RECORDS} 条），这次没有留档。请先处理已有的几条。填表功能不受影响。`
      };
    }
    if (reason === 'invalid_application_id') {
      return { tone: 'warn', text: '这不是桌面里的申请 ID（形如 1a2b3c4d-…-…），这次没有绑定。请在桌面申请详情里复制 ID 再试。' };
    }
    if (reason === 'unknown_record') {
      return { tone: 'warn', text: '这条留档已经不在待同步里了，可能已经发送过。' };
    }
    return { tone: 'warn', text: '这次没能留档，请稍后再试。填表功能不受影响。' };
  }

  if (status === 'not_recorded') {
    return { tone: 'info', text: '还没有和桌面程序配对，这次没有留档。填表功能不受影响。' };
  }

  if (status === 'failed') {
    return { tone: 'warn', text: FILL_REFUSALS[code] ?? REFUSALS[code] ?? '桌面拒绝了这次留档，请到桌面核对。' };
  }

  return { tone: 'warn', text: '这次没能留档到桌面，已经留在待同步里。' };
}

// A fill names an application that already exists, so the desktop's usual reason for
// refusing one is that the application is gone — not that a company name is wrong.
const FILL_REFUSALS = {
  invalid_payload: '桌面上找不到所选的申请，这次没有留档。请在「待同步」里重新选择申请。'
};

/**
 * One queued snapshot upload in the pending list. A lost copy is never offered as "retry":
 * there is nothing left to send, and rebuilding it from today's template would upload a
 * different resume under the old name (walkthrough 10.10).
 */
export function describeSnapshotUpload(entry, { expired = false } = {}) {
  const acked = (entry?.chunks ?? []).filter(chunk => chunk.acked).length;
  const total = entry?.chunkCount ?? 0;
  const byStatus = {
    bytes_lost: { text: '简历快照暂存丢失，请重新留档或在桌面导入。', retry: false },
    failed: { text: `简历快照被桌面拒绝，已停下（${REFUSALS[entry?.lastError] ?? '原因未知'}）`, retry: true },
    stalled: { text: '简历快照重试多次仍未传完，等你决定继续还是丢弃。', retry: true },
    paused: { text: '桌面换过档案库，简历快照已暂停。', retry: false },
    needs_user: { text: '桌面换过档案库，简历快照等你决定。', retry: false },
    completed: { text: '简历快照已传完，正在清理本机的暂存副本。', retry: false },
    discarding: { text: '已放弃这份简历快照，本机副本暂时删不掉，下次启动时再删；它不会再发送。', retry: false }
  };
  const copy = byStatus[entry?.status] ?? { text: `简历快照上传中（已传 ${acked}/${total} 块）`, retry: true };
  return expired ? { ...copy, text: `${copy.text}已暂存超过 30 天，要继续发送还是丢弃？` } : copy;
}
