import type { Invoke } from "../api.ts";
import { mountReact } from "../react/mount.tsx";
import { ResumeView } from "./ResumeView.tsx";
import type { FilePickers } from "./TemplateList.tsx";

export interface MountedResume {
  /**
   * 丢掉页面上的状态，模板列表和「我的信息」都重新读一遍。切到「简历」页和恢复备份
   * 之后调：档案可能已被换掉，留着旧的版本号再保存会盖掉刚恢复回来的内容。
   * 没保存的改动也会一起丢掉。
   */
  refresh(): void;
  unmount(): void;
}

/** 「简历」主视图。容器归 React 管，旧视图不往里写 innerHTML。 */
export function mountResume(container: Element, invoke: Invoke | null, pickers: FilePickers | null): MountedResume {
  let generation = 0;
  const view = () => <ResumeView key={generation} pickers={pickers} />;
  const mounted = mountReact(container, invoke, view());
  return {
    refresh: () => {
      // 换 key 让 React 整个重新挂载，各组件挂载时自己的读取就会再跑一次。
      generation += 1;
      mounted.update(view());
    },
    unmount: () => mounted.unmount(),
  };
}
