import { Fragment } from "react";
import type { RuntimeStatus as RuntimeStatusValue } from "../api.ts";
import { runtimeFactGroups } from "../runtime-facts.ts";

/**
 * 设置页「关于与诊断」里的技术详情：四组标签值，长路径换行。
 *
 * dt / dd 必须是 `.facts` 的直接子元素——那是个两列 grid，中间夹一层 div 会塌。
 * 读取失败时如实说失败；之前读到过的状态继续显示，但标明它不是最新的。
 */
export function RuntimeStatusFacts({ status, error = null }: { status: RuntimeStatusValue | null; error?: string | null }) {
  const failure = error ? (
    <p className="settings-callout" data-tone="error" role="alert">
      读取运行状态失败：{error}
      {status ? "。下面是上一次读到的状态。" : ""}
    </p>
  ) : null;
  if (!status) {
    return failure ?? <p className="muted">还没有拿到运行状态。</p>;
  }
  return (
    <>
      {failure}
      <div className="facts-groups">
        {runtimeFactGroups(status).map((group) => (
          <section key={group.title} className="facts-group" aria-label={group.title}>
            <h3>{group.title}</h3>
            <dl className="facts">
              {group.facts.map((fact) => (
                <Fragment key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>
                    <code>{fact.value}</code>
                  </dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}
