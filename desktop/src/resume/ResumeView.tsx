import { ProfileForm } from "./ProfileForm.tsx";
import { TemplateList } from "./TemplateList.tsx";
import type { FilePickers } from "./TemplateList.tsx";

/**
 * 简历模板与「我的信息」都归桌面管（#130）。插件侧边栏填写时从这里读：
 * 模板优先，模板里没有的字段再用「我的信息」补。
 */
export function ResumeView({ pickers }: { pickers: FilePickers | null }) {
  return (
    <div className="stack">
      <header>
        <h2>简历</h2>
        <p className="muted">插件填写网页时用这里的「当前模板」和「我的信息」。模板里已有的字段优先，其余由「我的信息」补上。</p>
      </header>
      <section aria-labelledby="resume-templates-title" className="stack">
        <h3 id="resume-templates-title">简历模板</h3>
        <TemplateList pickers={pickers} />
      </section>
      <section aria-labelledby="resume-profile-title" className="stack">
        <h3 id="resume-profile-title">我的信息</h3>
        <p className="muted">网申表常问、简历里通常没有的内容。</p>
        <ProfileForm />
      </section>
    </div>
  );
}
