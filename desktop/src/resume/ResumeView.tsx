import { useState } from "react";
import { LegacyImport } from "./LegacyImport.tsx";
import type { Listen } from "./LegacyImport.tsx";
import { ProfileForm } from "./ProfileForm.tsx";
import { ResumeParse } from "./ResumeParse.tsx";
import { TemplateList } from "./TemplateList.tsx";
import type { FilePickers } from "./TemplateList.tsx";

/**
 * 简历模板与「我的信息」都归桌面管（#130）。插件侧边栏填写时从这里读：
 * 模板优先，模板里没有的字段再用「我的信息」补。
 */
export function ResumeView({ pickers, listen }: { pickers: FilePickers | null; listen?: Listen }) {
  const [listKey, setListKey] = useState(0);
  const [profileKey, setProfileKey] = useState(0);
  return (
    <div className="stack">
      <header>
        <h2>简历</h2>
        <p className="muted">插件填写网页时用这里的「当前模板」和「我的信息」。模板里已有的字段优先，其余由「我的信息」补上。</p>
      </header>
      <LegacyImport
        listen={listen}
        onImported={() => {
          setListKey((k) => k + 1);
          setProfileKey((k) => k + 1);
        }}
      />
      <section aria-labelledby="resume-templates-title" className="stack">
        <h3 id="resume-templates-title">简历模板</h3>
        <ResumeParse onCreated={() => setListKey((k) => k + 1)} />
        <TemplateList key={listKey} pickers={pickers} />
      </section>
      <section aria-labelledby="resume-profile-title" className="stack">
        <h3 id="resume-profile-title">我的信息</h3>
        <p className="muted">网申表常问、简历里通常没有的内容。</p>
        <ProfileForm key={profileKey} />
      </section>
    </div>
  );
}
