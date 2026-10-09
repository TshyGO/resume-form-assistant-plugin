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
    if (reason === 'candidates_unavailable') {
      return {
        tone: 'pending',
        text: '还没能核对是不是同一个岗位，这次没有写入桌面。已记为待同步，稍后再完成保存。'
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

const MANUAL_SAVE = {
  no_fragments: '页面上没有能用来识别的文字。请手动填写公司和岗位。',
  cancelled: '已取消识别。请手动补全后再保存。',
  timeout: '识别超时。请手动补全后再保存。',
  internal: '识别出错了。请手动补全后再保存。',
  format: 'AI 返回的内容无法使用。请手动补全后再保存。',
  no_evidence: 'AI 给出的结果里有在页面上找不到依据的，这部分没有采用。请逐项核对后再保存。',
  location_no_evidence: 'AI 给的工作地点在页面上找不到依据，没有采用。请核对后再保存。',
  in_flight: '上一次识别还没结束。请手动补全后再保存。',
  swapped: '页面把公司和岗位写得不清楚，请核对后保存。',
  company_conflict: '页面出现多个不同的公司名，请确认这次投递的公司。',
  title_conflict: '页面出现多个不同的岗位名，请确认这次投递的岗位。',
  site_title_only: '页面标题不足以确认岗位，请手动核对。',
  title_unconfirmed: '岗位名还不确定。请核对后再保存。',
  missing_company: '公司名还不确定。请核对后再保存。',
  missing_title: '岗位名还不确定。请核对后再保存。'
};

const ASSIST_SOURCE = {
  'beisen-company': '公司名称',
  'beisen-apply-title': '职位标题',
  'jobposting-company': '招聘元数据 · 公司',
  'jobposting-title': '招聘元数据 · 岗位',
  'jobposting-location': '招聘元数据 · 工作地点',
  'og:title': '页面标题',
  h1: '页面标题',
  'document.title': '页面标题'
};

export function describeReviewSave() {
  return '可直接修改，确认后才会写入桌面。';
}

// `detail` is the desktop's failure, worded the same way the fill button words it.
export function describeManualSave(reason, detail = '') {
  if (detail) return `${detail}请手动补全后再保存。`;
  return MANUAL_SAVE[reason] || '请核对公司和岗位。缺的请自己补上，插件不会猜。';
}

export function describeJobAssist(disclosure) {
  const lines = (disclosure?.fragments || []).map(fragment => {
    const label = ASSIST_SOURCE[fragment.source] || '页面片段';
    return `${fragment.id}. ${label}：${fragment.text}`;
  });
  return {
    tone: 'info',
    text: '页面上的公司或岗位不好确定，正在用桌面当前的 AI 服务识别。只发送下面这几段页面文字：',
    fragments: lines
  };
}

// One sentence for "sent, but the answer never came back", shared by the page overlay and the
// side panel so the two cannot word it differently.
export const UNKNOWN_SAVE_TEXT = '没能确认保存结果，请到桌面或待同步列表核对后再操作。';

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

  if (status === 'unknown') {
    // The request went out and nothing came back. It may or may not have been written, so
    // this claims neither "saved" nor "queued", and there is no promise of a retry.
    return { tone: 'pending', text: UNKNOWN_SAVE_TEXT };
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
        text: result?.intent
          ? `岗位已留在待同步列表，但待发送消息已满（${MAX_OUTBOX} 条），还没有写入桌面。请先处理已有消息，再从待同步列表继续保存。`
          : `待同步的消息已满（${MAX_OUTBOX} 条），这次没有绑定。请先处理已有的几条。填表功能不受影响。`
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
    const detail = REFUSALS[code] ?? '桌面拒绝了这次写入，请到桌面核对。';
    return {
      tone: 'warn',
      text: result?.intent ? `${detail} 这条仍在待同步列表，请在那里处理，避免重复新建。` : detail
    };
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

// The desktop's own names for an application's stage, so a candidate reads the same in the
// side panel as it does in the applications list. An unknown code is shown as it came.
const STAGE_LABELS = {
  saved: '已保存',
  filling: '填写中',
  submitted: '已投递',
  assessment: '测评',
  interview: '面试',
  offer: 'Offer',
  rejected: '未通过',
  withdrawn: '已撤回',
  closed: '已关闭'
};

/** "公司 · 岗位（阶段）" for a desktop application. Never includes the application id. */
export function describeApplicationChoice(candidate) {
  const stage = typeof candidate?.stage === 'string' ? candidate.stage : '';
  const label = STAGE_LABELS[stage] ?? stage;
  return `${candidate?.company ?? ''} · ${candidate?.title ?? ''}${label ? `（${label}）` : ''}`;
}

// A confirmed submission only moves the application's stage on the desktop. These sentences
// never say the application was sent to the employer: that happened on the job site, and only
// the user knows it.
export const UNKNOWN_CONFIRM_TEXT = '没能确认结果，请到桌面端查看这条申请的当前状态。';

// Why "确认已投递" could not reach the desktop at all. Nothing was written and nothing was
// queued in any of these, so none of them may say "待同步".
export function describeConfirmBlocked(mode, { extensionId } = {}) {
  if (mode === 'not_installed') {
    return {
      tone: 'info',
      text: '没有找到桌面程序，这次没有确认投递。装好之后再回来确认。'
    };
  }
  if (mode === 'not_paired') {
    return {
      tone: 'info',
      extensionId,
      text: '桌面程序在运行，但还没有配对这个插件，这次没有确认投递。到桌面程序的设置里粘贴下面的扩展 ID。',
      hint: PAIRING_HINT
    };
  }
  if (mode === 'never_paired') {
    return {
      tone: 'info',
      extensionId,
      text: '还没有和桌面程序配对过，这次没有确认投递。打开桌面程序，在设置里粘贴下面的扩展 ID。',
      hint: PAIRING_HINT
    };
  }
  if (mode === 'incompatible') {
    return { tone: 'warn', text: '桌面程序的版本和插件对不上，这次没有确认投递，升级之后再试。' };
  }
  return {
    tone: 'warn',
    text: '桌面暂时连不上，这次没有确认投递，也没有排进待同步。桌面恢复后，请再点一次「确认已投递」。'
  };
}

export function describeConfirmResult(result) {
  if (result?.status === 'saved') {
    return { tone: 'success', text: '已投递：桌面上的阶段已经更新。' };
  }
  if (result?.status === 'rejected' && result.reason === 'no_application') {
    return { tone: 'warn', text: '请先选择这次投递对应的申请。' };
  }
  if (result?.status === 'rejected' && result.reason === 'queue_full') {
    return {
      tone: 'warn',
      text: `待同步的消息已满（${MAX_OUTBOX} 条），这次没有确认投递。请先处理已有的几条。`
    };
  }
  if (result?.status === 'unknown') {
    return { tone: 'pending', text: UNKNOWN_CONFIRM_TEXT };
  }
  if (result?.status === 'failed') {
    return { tone: 'warn', text: REFUSALS[result.code] ?? '桌面拒绝了这次确认，请到桌面核对这条申请。' };
  }
  // The router answers `pending` for a desktop it could not reach without queueing anything;
  // only a reply that names a queued message (`messageId`) proves an entry exists.
  if (result?.mode && !result.messageId) {
    return describeConfirmBlocked(result.mode, { extensionId: result.extensionId });
  }
  if (result?.status === 'pending' || result?.status === 'stalled') {
    // Saying anything about the stage here would be a claim about the desktop's records that
    // nothing has confirmed.
    return { tone: 'pending', text: '已排进待同步队列，桌面可用之后会更新阶段。' };
  }
  return { tone: 'warn', text: UNKNOWN_CONFIRM_TEXT };
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

/**
 * `application` is the candidate the user picked ({ company, title }), when there was one:
 * the success sentence then names it instead of "所选申请".
 */
export function describeFillRecordResult(result, { application = null, uploadShownSeparately = false } = {}) {
  const copy = describeFillRecordStatus(result, application);
  const extra = [];
  // The side panel shows the upload's live state on its own line; saying "正在后台上传" here
  // too would contradict that line once the upload is done.
  if (result?.status === 'saved' && result.uploadQueued && !uploadShownSeparately) {
    extra.push('简历快照正在后台上传，传完之前本机会保留一份。');
  }
  if (result?.snapshotIssue && SNAPSHOT_ISSUES[result.snapshotIssue]) {
    extra.push(SNAPSHOT_ISSUES[result.snapshotIssue]);
  }
  return extra.length ? { ...copy, text: `${copy.text}${extra.join('')}` } : copy;
}

function describeFillRecordStatus(result, application = null) {
  const { status, mode, reason, code } = result ?? {};

  if (status === 'saved') {
    // The only sentence that may say the desktop holds the record, and it runs only after a
    // persisted reply.
    const named = describeApplicationName(application);
    return {
      tone: 'success',
      text: named ? `已留档到桌面：这次填写的结果记在「${named}」下。` : '已留档到桌面：这次填写的结果记在所选申请下。'
    };
  }

  if (status === 'recorded') {
    // A waiting record is not an archived one (#178): the sentence says both halves.
    if (mode === 'incompatible') {
      return {
        tone: 'pending',
        text: `${FILL_ARCHIVE_PENDING_BIND}桌面程序的协议版本和插件对不上，升级之后才能留档。`
      };
    }
    return {
      tone: 'pending',
      text: `${FILL_ARCHIVE_PENDING_BIND}可以在「待同步」里选择这次填写属于哪条申请。`
    };
  }

  if (status === 'pending') {
    return { tone: 'pending', text: '已排进待同步队列，桌面可用之后会自动发送。现在还没有留档到桌面。' };
  }

  if (status === 'duplicate') {
    if (result?.receipt?.outcome === 'saved') {
      return { tone: 'success', text: '这次填写已留档到桌面，没有重复保存。请到桌面申请时间线核对。' };
    }
    if (result?.receipt?.outcome === 'discarded') {
      return { tone: 'info', text: '这次填写的留档已被放弃，没有重新创建。' };
    }
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

// --- #178: choosing the application for a fill in the native side panel ---------------
//
// Every question and answer of the side panel's archive card. Waiting ("待同步") and
// archived ("已留档到桌面") stay two different sentences; nothing here is shown before the
// user has chosen, and nothing claims the desktop has the record.

export const FILL_ARCHIVE_QUERYING = '正在查找对应的投递记录……';
export const FILL_ARCHIVE_CHOOSE = '这次填写属于哪条申请？';
export const FILL_ARCHIVE_EMPTY = '桌面里还没有这家公司的投递记录。';
export const FILL_ARCHIVE_PENDING_BIND = '已记入待同步，尚未选择申请。现在还没有留档到桌面。';
export const FILL_ARCHIVE_UNKNOWN = '没能确认留档结果，请到「待同步」或桌面端核对后再操作。';
export const FILL_ARCHIVE_SAVING = '正在留档到桌面……';
export const FILL_ARCHIVE_QUEUEING = '正在记入待同步……';

/** "公司 · 岗位" of the application a fill was filed under; empty when there is none. */
export function describeApplicationName(application) {
  const company = typeof application?.company === 'string' ? application.company.trim() : '';
  const title = typeof application?.title === 'string' ? application.title.trim() : '';
  return [company, title].filter(Boolean).join(' · ');
}

export function describeFillArchiveEmpty() {
  return {
    tone: 'info',
    text: FILL_ARCHIVE_EMPTY,
    hint: '可以先「保存岗位到桌面端」，保存好之后点「重新查找」选择申请；也可以稍后在待同步里选择。插件不会自动新建申请，也不会记到相似的岗位下。'
  };
}

const PENDING_BIND_OFFER = '可以先记入待同步，稍后在「待同步」里选择申请。现在还没有留档到桌面。';

/**
 * Why the side panel cannot list applications for this fill. `canQueue` says whether a
 * waiting record may be kept at all: only a profile that reached a paired desktop keeps one
 * (link/fillrecords.mjs `mayRecord`), so a missing or unpaired desktop is told so instead.
 */
export function describeFillArchiveBlocked(reason, { extensionId } = {}) {
  if (reason === 'unrecognized') {
    return { tone: 'warn', canQueue: true, text: '当前网页看不出是哪家公司，没法查找对应的申请。', hint: PENDING_BIND_OFFER };
  }
  if (reason === 'incompatible') {
    return {
      tone: 'warn', canQueue: true,
      text: '桌面程序的协议版本和插件对不上，没法查找对应的申请，升级之后才能留档。',
      hint: PENDING_BIND_OFFER
    };
  }
  if (reason === 'not_installed') {
    return { tone: 'info', canQueue: false, text: '没有找到桌面程序，这次没有留档。装好之后再回来；填表功能不受影响。' };
  }
  if (reason === 'not_paired') {
    return {
      tone: 'info', canQueue: false, extensionId,
      text: '桌面程序在运行，但还没有配对这个插件，这次没有留档。到桌面程序的设置里粘贴下面的扩展 ID。',
      hint: PAIRING_HINT
    };
  }
  if (reason === 'never_paired') {
    return {
      tone: 'info', canQueue: false, extensionId,
      text: '还没有和桌面程序配对过，这次没有留档。打开桌面程序，在设置里粘贴下面的扩展 ID。',
      hint: PAIRING_HINT
    };
  }
  return { tone: 'warn', canQueue: true, text: '桌面暂时连不上，没法查找对应的申请。', hint: PENDING_BIND_OFFER };
}

/**
 * The snapshot line under "已留档到桌面". `entry` is the snapshot's queue entry, or null once
 * it has left the queue. Only `confirmed` — the desktop's complete ACK — says "uploaded";
 * `dropped` means the user gave it up. An entry that left the queue for any other reason
 * (another window dropped it, the worker restarted before the answer was read) is said to
 * have left, never to have been uploaded. `queried` distinguishes a completed queue read
 * after saving from the brief moment before that first read.
 */
export function describeFillSnapshotProgress(entry, { seen = false, queried = false, dropped = false, confirmed = false } = {}) {
  if (confirmed) return { text: '简历快照已上传到桌面。', retry: false };
  if (dropped) return { text: '简历快照已丢弃，没有上传到桌面。', retry: false };
  if (entry) return describeSnapshotUpload(entry);
  if (seen || queried) return { text: '简历快照已不在上传队列里，没有收到上传完成的确认，可以到桌面这条申请的时间线里核对。', retry: false };
  return { text: '简历快照正在后台上传，传完之前本机会保留一份。', retry: false };
}

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

// A snapshot upload paused by a restore. Neither answer below lets the plugin act alone, and
// uploading again always means a new snapshot identity in the archive that exists now.
const SNAPSHOT_RECONCILE = {
  applied: '恢复后的档案库里有这份快照全部分片的记录，但无法确认它是否已完整入库。',
  not_found: '恢复后的档案库里没有这份快照的上传记录。这不等于没有传过——可能只是这份备份不含它。',
  conflict: '恢复后的档案库里有身份相同但内容不同的分片，没有自动处理。',
  unverifiable: '桌面无法核实这份快照传到了哪一步，不会自动重传。',
  purged: '这份快照所属的记录在桌面上已被永久删除。'
};

/** What the sidebar says after the user resolved a paused snapshot. */
export function describeSnapshotResolveResult(result) {
  const { status, reason } = result ?? {};
  if (status === 'queued' || status === 'pending') {
    return { tone: 'pending', text: '会用当前档案库的新身份重新上传同一份简历快照，等这次填写的留档发出之后开始。' };
  }
  if (status === 'discarded') return { tone: 'info', text: '已丢弃这份简历快照，填写记录不受影响。' };
  if (status === 'rejected' && SNAPSHOT_ISSUES[reason]) return { tone: 'warn', text: SNAPSHOT_ISSUES[reason] };
  return { tone: 'warn', text: '没能重新上传这份简历快照，它还留在待同步里。' };
}

export function describeSnapshotReconcile(status) {
  return {
    tone: 'warn',
    text: `${SNAPSHOT_RECONCILE[status] ?? '桌面换过档案库，这份简历快照等你决定。'}可以把本机保留的原始快照重新上传到当前档案库，或者丢弃它。`,
    choices: ['resave', 'discard']
  };
}

// --- #178: the side panel's pending list ------------------------------------------------
//
// The same wording the page overlay's pending list uses, kept here so the side panel does not
// grow a third copy of it. A queue state is never "saved": everything listed is still waiting.

const QUEUE_FAILURES = {
  unavailable: '桌面暂时不可用',
  invalid_payload: '桌面看不懂这条内容',
  restore_epoch_mismatch: '桌面换过档案库',
  previously_purged: '已在桌面永久删除',
  conflict: '与桌面已有记录冲突'
};

export function describeQueueFailure(code) {
  return QUEUE_FAILURES[code] ?? '原因未知';
}

/** One bound message's state, in the pending list. `formatTime` turns an ISO time into a clock. */
export function describeQueueEntryState(entry, { formatTime = null } = {}) {
  if (entry?.status === 'paused') return '桌面换过档案库，已暂停';
  if (entry?.status === 'needs_user') return '桌面换过档案库，等你决定';
  if (entry?.status === 'failed') return `已停下，需要处理（${describeQueueFailure(entry.lastError)}）`;
  if (entry?.status === 'stalled') return `重试多次仍未成功，等你决定（${describeQueueFailure(entry.lastError)}）`;
  const at = entry?.nextAttemptAt && formatTime ? formatTime(entry.nextAttemptAt) : '';
  const next = at ? `，下次重试 ${at}` : '';
  return `待同步（已尝试 ${entry?.attempts || 0} 次${next}）`;
}

export function describeQueueEntryLabel(entry) {
  if (entry?.messageType === 'fill.submit') return `填写留档 · ${entry.payload?.templateName || ''}`;
  if (entry?.messageType === 'submit.confirm') return '确认已投递';
  if (entry?.messageType === 'snapshot.upload') return `简历快照 · ${entry.payload?.templateName || ''}`;
  return `${entry?.payload?.company || ''} · ${entry?.payload?.title || ''}`;
}

/** What a retried or resolved entry's answer means, in the words of its own kind. */
export function describeQueueOutcome(entry, result) {
  if (entry?.messageType === 'fill.submit') return describeFillRecordResult(result);
  if (entry?.messageType === 'snapshot.upload') return describeSnapshotResolveResult(result);
  if (entry?.messageType === 'submit.confirm') return describeConfirmResult(result);
  return describeBindResult(result);
}
