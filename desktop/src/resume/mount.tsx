import type { Invoke } from "../api.ts";
import { mountReact } from "../react/mount.tsx";
import { ResumeView } from "./ResumeView.tsx";
import type { ResumeLeaveGate } from "./ResumeView.tsx";
import type { FilePickers } from "./TemplateList.tsx";
import type { Listen } from "./LegacyImport.tsx";

export interface MountedResume {
  /**
   * 模板列表重新读一遍，「我的信息」从已保存的档案重新开始。切到「简历」页和恢复备份
   * 之后调：档案可能已被换掉，留着旧的版本号再保存会盖掉刚恢复回来的内容。
   * 没保存的改动也会一起丢掉——所以离开简历页前要先过 confirmLeave。
   * 进行中的 AI 解析不受影响，回来后仍能查看或取消。
   */
  refresh(): void;
  /**
   * 要离开简历页时问一句：「我的信息」有没保存的修改就弹确认，用户选「放弃并离开」才返回 true。
   * 顶栏切页和插件要求打开别的页都走这里（#257）。
   */
  confirmLeave(): Promise<boolean>;
  unmount(): void;
}

/** 「简历」主视图。容器归 React 管，旧视图不往里写 innerHTML。 */
export function mountResume(
  container: Element,
  invoke: Invoke | null,
  pickers: FilePickers | null,
  listen?: Listen,
): MountedResume {
  let generation = 0;
  const gate = { current: {} as ResumeLeaveGate };
  const view = () => <ResumeView generation={generation} pickers={pickers} listen={listen} gate={gate} />;
  const mounted = mountReact(container, invoke, view());
  return {
    refresh: () => {
      generation += 1;
      mounted.update(view());
    },
    confirmLeave: () => gate.current.confirmLeave?.() ?? Promise.resolve(true),
    unmount: () => mounted.unmount(),
  };
}
