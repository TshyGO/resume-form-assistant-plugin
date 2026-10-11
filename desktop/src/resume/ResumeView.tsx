import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject } from "react";
import { LegacyImport } from "./LegacyImport.tsx";
import type { Listen } from "./LegacyImport.tsx";
import { ProfileForm } from "./ProfileForm.tsx";
import type { ProfileProbe } from "./ProfileForm.tsx";
import { DialogQueueProvider, ResumeDialog } from "./ResumeDialog.tsx";
import { useResumeParse } from "./ResumeParse.tsx";
import { TemplateList } from "./TemplateList.tsx";
import type { FilePickers, ReloadSignal } from "./TemplateList.tsx";

export type ResumeSubview = "templates" | "profile";

/** 页面外（顶栏、插件要求打开别的页）问简历页能不能离开。由 mount.tsx 持有。 */
export interface ResumeLeaveGate {
  confirmLeave?: () => Promise<boolean>;
}

const TABS: Array<{ id: ResumeSubview; label: string }> = [
  { id: "templates", label: "简历模板" },
  { id: "profile", label: "我的信息" },
];

/**
 * 简历模板与「我的信息」都归桌面管（#130）。插件侧边栏填写时从这里读：
 * 模板优先，模板里没有的字段再用「我的信息」补。
 *
 * #257：两个子视图共用页眉和切换控件。两个视图始终挂着、只切换显示，
 * 所以切过去再切回来不会清空「我的信息」草稿，也不会打断进行中的 AI 解析。
 */
export function ResumeView(props: {
  pickers: FilePickers | null;
  listen?: Listen;
  /** 变了就重新读模板列表，并让「我的信息」从已保存的档案重新开始（恢复备份、重新进入简历页）。 */
  generation?: number;
  gate?: MutableRefObject<ResumeLeaveGate>;
  extract?: (file: File) => Promise<string>;
}) {
  return (
    <DialogQueueProvider>
      <ResumeWorkspace {...props} />
    </DialogQueueProvider>
  );
}

function ResumeWorkspace({
  pickers,
  listen,
  generation = 0,
  gate,
  extract,
}: {
  pickers: FilePickers | null;
  listen?: Listen;
  generation?: number;
  gate?: MutableRefObject<ResumeLeaveGate>;
  extract?: (file: File) => Promise<string>;
}) {
  const [view, setView] = useState<ResumeSubview>("templates");
  const [listSignal, setListSignal] = useState<ReloadSignal>({ token: 0 });
  const [leaving, setLeaving] = useState(false);
  const leaveResolver = useRef<((ok: boolean) => void) | null>(null);
  const profileProbe = useRef<ProfileProbe | null>(null);
  const tabRefs = useRef<Record<ResumeSubview, HTMLButtonElement | null>>({ templates: null, profile: null });

  const parse = useResumeParse({
    onCreated: (templateId) => setListSignal((signal) => ({ token: signal.token + 1, select: templateId })),
    extract,
  });

  // 重新进入简历页 / 恢复备份：模板列表重读；「我的信息」整块重挂，从档案重新开始。
  // 只有离开时已经确认过放弃（或本来就没草稿）才会走到这里，所以不会悄悄丢掉输入。
  const firstGeneration = useRef(generation);
  useEffect(() => {
    if (generation === firstGeneration.current) return;
    firstGeneration.current = generation;
    // AI 解析的结果提示不清：解析可能是在别的页时才完成的，回来要能看到结果。
    setListSignal((signal) => ({ token: signal.token + 1 }));
  }, [generation]);

  useEffect(() => {
    if (!gate) return undefined;
    gate.current.confirmLeave = () => {
      if (!profileProbe.current?.dirty()) return Promise.resolve(true);
      // 已经在问了（比如插件又要求打开别的页）：后来的请求按「不离开」处理，等用户回答眼前这一个。
      if (leaveResolver.current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        leaveResolver.current = resolve;
        setLeaving(true);
      });
    };
    return () => {
      gate.current.confirmLeave = undefined;
      leaveResolver.current?.(false);
      leaveResolver.current = null;
    };
  }, [gate]);

  const answerLeave = (ok: boolean) => {
    setLeaving(false);
    const resolve = leaveResolver.current;
    leaveResolver.current = null;
    resolve?.(ok);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === view);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    setView(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  };

  return (
    <div className="resume-view">
      <header className="resume-header">
        <div>
          <h1>简历资料</h1>
          <p>插件填写网页时优先用「当前模板」，模板里没有的字段再用「我的信息」补上。</p>
        </div>
        <div className="resume-switch" role="tablist" aria-label="简历内容">
          {TABS.map((tab) => {
            const selected = tab.id === view;
            const busy = tab.id === "templates" && parse.active && !selected;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                id={`resume-tab-${tab.id}`}
                aria-controls={`resume-panel-${tab.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setView(tab.id)}
                onKeyDown={onTabKey}
              >
                {tab.label}
                {busy ? (
                  <span className="resume-switch-busy" title="AI 解析进行中">
                    <span className="sr-only">（AI 解析进行中）</span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>
      <LegacyImport
        key={generation}
        listen={listen}
        onImported={() => {
          setListSignal((signal) => ({ token: signal.token + 1 }));
          profileProbe.current?.sync();
        }}
      />
      <div
        role="tabpanel"
        id="resume-panel-templates"
        aria-labelledby="resume-tab-templates"
        className="resume-panel"
        hidden={view !== "templates"}
      >
        <TemplateList pickers={pickers} reloadSignal={listSignal} parse={parse} />
      </div>
      <div
        role="tabpanel"
        id="resume-panel-profile"
        aria-labelledby="resume-tab-profile"
        className="resume-panel"
        hidden={view !== "profile"}
      >
        <ProfileForm key={generation} listen={listen} probe={profileProbe} />
      </div>
      <ResumeDialog
        open={leaving}
        tone="warn"
        title="放弃当前草稿？"
        onCancel={() => answerLeave(false)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => answerLeave(false)}>继续编辑</button>
            <button type="button" className="danger" onClick={() => answerLeave(true)}>放弃并离开</button>
          </>
        }
      >
        <p>「我的信息」里有还没保存的修改。离开简历页会丢失这些修改，插件仍使用上次保存的信息。</p>
      </ResumeDialog>
    </div>
  );
}
