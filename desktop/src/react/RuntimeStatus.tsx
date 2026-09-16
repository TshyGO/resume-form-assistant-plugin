import { Fragment } from "react";
import type { RuntimeStatus as RuntimeStatusValue } from "../api.ts";
import { runtimeFacts } from "../runtime-facts.ts";

/**
 * 设置页顶部的运行状态。D11 PR 3 的示范组件：证明挂载、打包、CSP 这条链是通的。
 *
 * dt / dd 必须是 `.facts` 的直接子元素——那是个两列 grid，中间夹一层 div 会塌。
 */
export function RuntimeStatusFacts({ status }: { status: RuntimeStatusValue | null }) {
  if (!status) {
    return <p className="muted">还没有拿到运行状态。</p>;
  }
  return (
    <dl className="facts">
      {runtimeFacts(status).map((fact) => (
        <Fragment key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>
            <code>{fact.value}</code>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
