import type { Invoke } from "../api.ts";
import { mountReact } from "../react/mount.tsx";
import { ResumeView } from "./ResumeView.tsx";
import type { FilePickers } from "./TemplateList.tsx";

/** 「简历」主视图。容器归 React 管，旧视图不往里写 innerHTML。 */
export function mountResume(container: Element, invoke: Invoke | null, pickers: FilePickers | null) {
  return mountReact(container, invoke, <ResumeView pickers={pickers} />);
}
