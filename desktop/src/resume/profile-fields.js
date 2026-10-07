// 「我的信息」：网申表常问、简历里通常没有的字段。设置页、侧边栏和测试共用这一份定义。
(function attachResumeProProfile(globalScope) {
  const YES_NO = ["是", "否"];

  // id 是存储用的键，改了会丢用户数据；key 是交给匹配规则和 AI 的字段名，也是侧边栏芯片上的字。
  // 地区字段的 key 按「归属 + 层级」命名（籍贯省、户口所在地区县），ai-helpers 靠它分清省市县。
  // aliases 只用来判断「网页上这个字段我们已经有了」，不会作为字段名交出去。
  const PROFILE_SCHEMA = [
    {
      name: "基本信息",
      fields: [
        { id: "name", key: "姓名", aliases: ["真实姓名"] },
        { id: "namePinyin", key: "姓名拼音", placeholder: "ZHANG SAN", aliases: ["拼音"] },
        { id: "usedName", key: "曾用名" },
        { id: "gender", key: "性别", type: "select", options: ["男", "女"] },
        { id: "birth", key: "出生年月", type: "month", aliases: ["出生日期", "生日"] },
        { id: "ethnicity", key: "民族", placeholder: "汉族" },
        { id: "political", key: "政治面貌", type: "select", options: ["中共党员", "中共预备党员", "共青团员", "民主党派", "群众"] },
        { id: "marital", key: "婚姻状况", type: "select", options: ["未婚", "已婚", "离异", "丧偶"] },
        { id: "idType", key: "证件类型", type: "select", options: ["居民身份证", "护照", "港澳居民来往内地通行证", "台湾居民来往大陆通行证", "其他"] },
        { id: "idNumber", key: "证件号码", aliases: ["证件号", "身份证号", "身份证号码"] },
        { id: "height", key: "身高", label: "身高（厘米）" },
        { id: "weight", key: "体重", label: "体重（公斤）" },
        { id: "health", key: "健康状况", type: "select", options: ["健康", "良好", "一般"] },
        { id: "seriousDisease", key: "有无重大疾病史", type: "select", options: ["无", "有"] }
      ]
    },
    {
      name: "户籍与地区",
      fields: [
        { id: "nativeProvince", key: "籍贯省", label: "籍贯（省）" },
        { id: "nativeCity", key: "籍贯市", label: "籍贯（市）" },
        { id: "nativeCounty", key: "籍贯县", label: "籍贯（区县）" },
        { id: "hukouProvince", key: "户口所在地省", label: "户口所在地（省）" },
        { id: "hukouCity", key: "户口所在地市", label: "户口所在地（市）" },
        { id: "hukouCounty", key: "户口所在地区县", label: "户口所在地（区县）" },
        { id: "hukouType", key: "户口性质", type: "select", options: ["城镇", "农村"] },
        { id: "examProvince", key: "高考生源地省", label: "高考生源地（省）" },
        { id: "examCity", key: "高考生源地市", label: "高考生源地（市）" },
        { id: "homeAddress", key: "家庭住址", type: "textarea", aliases: ["家庭地址"] },
        { id: "currentAddress", key: "现居住地", type: "textarea", aliases: ["现住址", "居住地址", "通讯地址"] }
      ]
    },
    {
      name: "联系方式",
      fields: [
        { id: "phone", key: "手机号码", aliases: ["手机", "手机号", "移动电话", "联系电话"] },
        { id: "email", key: "常用邮箱", aliases: ["邮箱", "电子邮箱", "电子邮件"] },
        { id: "emergencyName", key: "紧急联系人姓名", aliases: ["紧急联系人"] },
        { id: "emergencyRelation", key: "紧急联系人关系", placeholder: "父亲" },
        { id: "emergencyPhone", key: "紧急联系人电话", aliases: ["紧急联系电话", "紧急联系人手机"] }
      ]
    },
    {
      name: "教育补充",
      fields: [
        { id: "highestEducation", key: "最高学历", type: "select", options: ["博士研究生", "硕士研究生", "大学本科", "大学专科", "高中及以下"], aliases: ["学历"] },
        { id: "highestDegree", key: "最高学位", type: "select", options: ["博士", "硕士", "学士", "无"], aliases: ["学位"] },
        { id: "studyMode", key: "学习形式", type: "select", options: ["全日制", "非全日制"] },
        { id: "graduation", key: "毕业时间", type: "month", aliases: ["毕业日期"] },
        { id: "classRank", key: "专业排名", placeholder: "前 10%" },
        { id: "studentCadre", key: "是否学生干部", type: "select", options: YES_NO },
        { id: "doubleDegree", key: "是否双学位", type: "select", options: YES_NO },
        { id: "upgrade", key: "是否专升本", type: "select", options: YES_NO },
        { id: "highSchool", key: "高中毕业学校" }
      ]
    },
    {
      name: "语言与技能",
      fields: [
        { id: "language", key: "外语语种", placeholder: "英语", aliases: ["外语"] },
        { id: "languageLevel", key: "外语等级", placeholder: "CET-6" },
        { id: "languageScore", key: "外语成绩" },
        { id: "computerLevel", key: "计算机水平" },
        { id: "skills", key: "技能特长", type: "textarea" }
      ]
    },
    {
      name: "求职补充",
      fields: [
        { id: "expectedCity", key: "期望工作地点" },
        { id: "availableDate", key: "可到岗时间" },
        { id: "acceptAdjustment", key: "是否服从调剂", type: "select", options: YES_NO },
        { id: "specialCategory", key: "专项招聘类别" },
        { id: "awards", key: "奖励荣誉", type: "textarea" }
      ]
    }
  ];

  const FAMILY_GROUP = "家庭主要成员";
  const FAMILY_RELATIONS = ["父亲", "母亲", "配偶", "兄弟姐妹", "子女", "其他亲属"];
  // 这几种关系只会有一个人，备份追加时按关系对上；其他关系按姓名对上。
  const SINGLE_RELATIONS = new Set(["父亲", "母亲", "配偶"]);
  const FAMILY_FIELDS = [
    { id: "name", key: "姓名" },
    { id: "birth", key: "出生年月", type: "month" },
    { id: "political", key: "政治面貌" },
    { id: "company", key: "工作单位" },
    { id: "job", key: "职务" },
    { id: "phone", key: "联系电话" }
  ];

  const CUSTOM_GROUP = "补充字段";
  const MAX_CUSTOM_FIELDS = 200;
  const MAX_OFFERED_LABELS = 20;
  // #189：已填项也进候选，一张表上可复用的内容比空字段多，上限放宽；超出的只报个数。
  const MAX_OFFERED_CANDIDATES = 40;
  // 单项内容的上限；超出的多半是整段作答，不当作可复用信息。桌面整份档案另有 24 KB 上限（MAX_PROFILE_BYTES）。
  const MAX_CANDIDATE_VALUE_CHARS = 2000;
  const MAX_PROFILE_BYTES = 24 * 1024;
  // 长题目要整句留着（#228），只防住异常长的整段文字。和 field-scan.js 的 MAX_OFFER_CHARS 一致。
  const MAX_OFFERED_LABEL_CHARS = 120;
  // 扫描已经不会把这些当字段名；这里再兜一层：纯计数器、纯占位文字不进「我的信息」。
  const NOT_A_LABEL = /^[\d\s\/／()（）]+$|^(?:请)?(?:选择|输入|填写|上传|搜索)$/;

  // #228：可以加多条的经历（教育、实习、获奖、证书……）里的字段，换个网站就对不上是哪一条，
  // 交给简历模板，不进「我的信息」。「语言」「技能」不算：上面「语言与技能」本来就是单值信息。
  const ENTRY_SECTION = /经历|教育背景|学习背景|实习|工作经验|任职|项目|科研|研究成果|获奖|奖项|奖励|荣誉|专利|证书|资格|论文|专著|发表|成果|培训|实践|校园|学生干部|学生工作|社团|家庭|成员|亲属/;
  const INTENT_SECTION = /意向|期望|求职/;
  const FAMILY_SECTION = /家庭|成员|亲属/;
  // 和上面「教育补充」「语言与技能」「求职补充」同类的概括信息，出现在经历区块里也照收（「班级排名」之于「专业排名」）。
  const PROFILE_LIKE_TITLE = /排名|最高学历|最高学位|学习形式|学生干部|双学位|专升本|外语|英语|语种|四六级|cet|计算机|技能|特长/i;
  // 找不到所属区块时，离开上下文就看不懂的题目不问。
  const CONTEXTLESS_TITLE = /^(?:名称|名字|时间|开始时间|结束时间|起止时间|起始时间|获得时间|日期|描述|说明|备注|类型|类别|级别|等级|内容|地点|单位|职务|角色)$/;

  const SKIPPED_INPUT_TYPES = new Set(["password", "file", "checkbox", "hidden", "submit", "button", "reset", "image"]);
  // 补充字段是用户自己起的名，拦不住一行叫「网银密码」：这种字段不推荐、不交给 AI。
  const SECRET_LABEL = /密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret/i;
  // 名字普通、内容却是「密码：xxx」这种写法的，同样不交给 AI。
  const SECRET_VALUE = /(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S/i;
  // 网页自己声明了这是密码、一次性验证码或银行卡信息（autocomplete 属性）：不管字段名怎么写都不收。
  const SENSITIVE_AUTOCOMPLETE = /one-time-code|cc-|password/i;
  // 明显只适用于当前岗位/公司的作答：可以列出来，但不默认勾选。
  const JOB_SPECIFIC_LABEL = /为什么|原因|理由|动机|谈谈|请(?:简述|简要|描述|介绍|说明|阐述)|自我评价|自我介绍|应聘|报考|投递|[本该贵](?:岗位|职位|公司|单位)|岗位|职位|招聘(?:信息|渠道)|得知|推荐人|内推/;
  const JOB_SPECIFIC_VALUE_CHARS = 300;

  function text(value) {
    return String(value ?? "").trim();
  }

  function normalizeKey(value) {
    return text(value).toLowerCase().replace(/[\s:：*（）()【】[\]\-_/.·]+/g, "");
  }

  function emptyProfile() {
    return { values: {}, family: [], custom: [] };
  }

  function normalizeProfile(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const profile = emptyProfile();

    if (source.values && typeof source.values === "object") {
      for (const [id, value] of Object.entries(source.values)) {
        const clean = text(value);
        if (clean) profile.values[id] = clean;
      }
    }

    for (const member of Array.isArray(source.family) ? source.family : []) {
      if (!member || typeof member !== "object") continue;

      const relation = text(member.relation);
      const next = { relation: FAMILY_RELATIONS.includes(relation) ? relation : "其他亲属" };
      FAMILY_FIELDS.forEach((field) => {
        next[field.id] = text(member[field.id]);
      });

      if (FAMILY_FIELDS.some((field) => next[field.id])) {
        profile.family.push(next);
      }
    }

    // 值为空的补充字段也留着：那是从网页上加进来、等用户补内容的。
    // 同名的只留一条，优先留有内容的，免得先加的空行把后填的内容挤掉。
    const byKey = new Map();
    for (const item of Array.isArray(source.custom) ? source.custom : []) {
      const key = text(item?.key);
      const normalized = normalizeKey(key);
      if (!normalized) continue;

      const value = text(item?.value);
      const existing = byKey.get(normalized);
      if (existing) {
        if (!existing.value && value) existing.value = value;
        continue;
      }
      if (byKey.size >= MAX_CUSTOM_FIELDS) continue;
      byKey.set(normalized, { key, value });
    }
    profile.custom = [...byKey.values()];

    return profile;
  }

  // 同一关系有多人时加序号（兄弟姐妹1、兄弟姐妹2），只有一人时不加。
  function familyPrefixes(family) {
    const totals = {};
    family.forEach((member) => {
      totals[member.relation] = (totals[member.relation] || 0) + 1;
    });
    const seen = {};
    return family.map((member) => {
      seen[member.relation] = (seen[member.relation] || 0) + 1;
      return totals[member.relation] > 1 ? `${member.relation}${seen[member.relation]}` : member.relation;
    });
  }

  function profileToResumeFields(rawProfile) {
    const profile = normalizeProfile(rawProfile);
    const fields = [];

    PROFILE_SCHEMA.forEach((group) => {
      group.fields.forEach((field) => {
        const value = profile.values[field.id];
        if (value) fields.push({ group: group.name, key: field.key, value });
      });
    });

    const prefixes = familyPrefixes(profile.family);
    profile.family.forEach((member, index) => {
      // 家庭成员表格里常有一列「关系 / 称谓」下拉框。
      fields.push({ group: FAMILY_GROUP, key: `${prefixes[index]}关系`, value: member.relation });
      FAMILY_FIELDS.forEach((field) => {
        if (member[field.id]) fields.push({ group: FAMILY_GROUP, key: `${prefixes[index]}${field.key}`, value: member[field.id] });
      });
    });

    const emitted = new Set(fields.map((field) => normalizeKey(field.key)));
    profile.custom.forEach((item) => {
      const normalized = normalizeKey(item.key);
      if (!item.value || SECRET_LABEL.test(item.key) || SECRET_VALUE.test(item.value) || emitted.has(normalized)) return;
      emitted.add(normalized);
      fields.push({ group: CUSTOM_GROUP, key: item.key, value: item.value });
    });

    return fields;
  }

  // 旧数据迁到桌面前用（#130 PR 5）：桌面档案会随备份带走，像密码、验证码的项不收，
  // 整份送过去会被整片拒绝。这里先剔掉，与桌面 reject_profile_secrets 同一口径。
  function stripProfileSecrets(rawProfile) {
    const profile = normalizeProfile(rawProfile);
    let removed = 0;
    for (const [id, value] of Object.entries(profile.values)) {
      if (SECRET_VALUE.test(value)) {
        delete profile.values[id];
        removed += 1;
      }
    }
    profile.family = profile.family
      .map((member) => {
        const next = { ...member };
        FAMILY_FIELDS.forEach((field) => {
          if (next[field.id] && SECRET_VALUE.test(next[field.id])) {
            next[field.id] = "";
            removed += 1;
          }
        });
        return next;
      })
      .filter((member) => FAMILY_FIELDS.some((field) => member[field.id]));
    profile.custom = profile.custom.filter((item) => {
      const secret = SECRET_LABEL.test(item.key) || SECRET_VALUE.test(item.value);
      if (secret) removed += 1;
      return !secret;
    });
    return { profile, removed };
  }

  function countProfileValues(profile) {
    return profileToResumeFields(profile).length;
  }

  function countPendingFields(profile) {
    return normalizeProfile(profile).custom.filter((item) => !item.value).length;
  }

  function hasProfileContent(profile) {
    const normalized = normalizeProfile(profile);
    return Boolean(Object.keys(normalized.values).length || normalized.family.length || normalized.custom.length);
  }

  // 模板优先：模板里已有的字段名，档案里的同名字段不再加入。
  function mergeResumeFields(templateFields, profileFields) {
    const template = Array.isArray(templateFields) ? templateFields : [];
    const taken = new Set(template.map((field) => normalizeKey(field?.key)));

    return [
      ...template,
      ...(Array.isArray(profileFields) ? profileFields : []).filter((field) => !taken.has(normalizeKey(field.key)))
    ];
  }

  // 已经有着落的字段名：预置字段（字段名、界面标签、别名）、已有家庭成员的全部字段、补充字段、模板字段。
  function knownFieldKeys(rawProfile, resumeFields) {
    const profile = normalizeProfile(rawProfile);
    const keys = new Set();
    const add = (value) => {
      const normalized = normalizeKey(value);
      if (normalized) keys.add(normalized);
    };

    PROFILE_SCHEMA.forEach((group) => group.fields.forEach((field) => {
      add(field.key);
      add(field.label);
      (field.aliases || []).forEach(add);
    }));
    // 成员已经在档案里、只是某一项没填：这一项该去成员那里补，不该另起一个补充字段。
    familyPrefixes(profile.family).forEach((prefix) => {
      add(`${prefix}关系`);
      FAMILY_FIELDS.forEach((field) => add(`${prefix}${field.key}`));
    });
    profile.custom.forEach((item) => add(item.key));
    (Array.isArray(resumeFields) ? resumeFields : []).forEach((field) => add(field?.key));

    return keys;
  }

  // 经历类区块里的字段：返回要用的名字（同类概括信息）或 null（不收）。
  function entryFieldLabel(candidate) {
    const section = text(candidate?.section);
    const title = text(candidate?.title ?? candidate?.label);
    if (!section) return CONTEXTLESS_TITLE.test(title) ? null : undefined;
    if (FAMILY_SECTION.test(section)) return null;
    const entry = candidate?.sectionRepeatable || (ENTRY_SECTION.test(section) && !INTENT_SECTION.test(section));
    if (!entry) return undefined;
    return PROFILE_LIKE_TITLE.test(title) ? title : null;
  }

  // 候选字段的名字：对不上题目、噪声和敏感类控件返回空串。「加到我的信息」的两条路（只收空字段的旧筛选、
  // 连已填项一起收的候选规划）共用这一道，字段识别范围不会因为后者而变。
  function candidateLabel(candidate, stats = null) {
    const entryLabel = entryFieldLabel(candidate);
    if (entryLabel === null) {
      if (stats) stats.entry = (stats.entry || 0) + 1;
      return "";
    }
    const label = text(entryLabel ?? candidate?.label);
    const normalized = normalizeKey(label);

    if (normalized.length < 2 || label.length > MAX_OFFERED_LABEL_CHARS || NOT_A_LABEL.test(label)) return "";
    if (SKIPPED_INPUT_TYPES.has(candidate?.inputType) || SECRET_LABEL.test(label)) return "";
    if (SENSITIVE_AUTOCOMPLETE.test(text(candidate?.autocomplete))) return "";
    return label;
  }

  // 一次填写之后，网页上既没匹配上、也还空着的字段。密码验证码、文件、勾选框、经历类区块里的字段不算。
  function pickUnansweredLabels(candidates, knownKeys, limit = MAX_OFFERED_LABELS, stats = null) {
    const picked = [];
    const seen = new Set();

    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (candidate?.matched || candidate?.hasValue) continue;
      const label = candidateLabel(candidate, stats);
      if (!label) continue;
      const normalized = normalizeKey(label);
      if (knownKeys?.has(normalized) || seen.has(normalized)) continue;

      seen.add(normalized);
      picked.push(label);
      if (picked.length >= limit) break;
    }

    return picked;
  }

  function sameValue(left, right) {
    const squash = (value) => text(value).replace(/\s+/g, " ");
    return squash(left) === squash(right);
  }

  const SKIP_TEXT = {
    secret: (key) => `「${key}」的内容像密码或验证码，不会保存。`,
    stale: (key) => `「${key}」所在的网页内容已经变化，对不上了；重新一键填写后可再保存。`,
    "too-long": (key) => `「${key}」的内容太长，不会保存。`,
    ambiguous: (key) => `「${key}」在网页上出现多次且内容不同，没有保存。`,
    "fixed-conflict": (key) => `「${key}」在桌面已有内容（来自简历模板或预置字段），与网页不同，没有保存。`,
    "fixed-empty": (key) => `「${key}」属于简历模板或预置字段，请在桌面「我的信息」里直接填写，没有保存。`,
    same: (key) => `「${key}」桌面里已经有相同内容，没有重复保存。`,
    cleared: (key) => `「${key}」在网页上已经清空，没有保存。`,
    "value-changed": (key) => `「${key}」网页内容已变化，请核对更新后的内容再保存。`,
    "existing-changed": (key) => `「${key}」在桌面里刚有了不同的内容，没有覆盖；请重新核对后再保存。`,
    "conflict-unconfirmed": (key) => `「${key}」与桌面已有内容不同，需要勾选「替换」才会覆盖，没有保存。`,
    gone: (key) => `「${key}」在网页上找不到了，没有保存。`,
    full: (key) => `「${key}」放不下：「我的信息」已满，先在桌面删掉用不上的补充字段。`
  };

  function skipNote(id, key, reason) {
    return { id, key, reason, text: SKIP_TEXT[reason](key) };
  }

  // 候选规划（#189）：网页上没对上简历、也不在经历区块里的字段，连同它们此刻的内容，按桌面现有档案分好类。
  // candidates 每项是 { label, …题目信息, matched, state: ready|stale|unreadable, value, autocomplete }，
  // 内容由网页端在读取那一刻填，这里不碰页面。同名字段只留一条（id 就是规范化后的字段名）：
  //   filled   已填、可保存的新字段；completes 表示补全桌面里同名的待补充项
  //   pending  只有字段名（网页上空着，或有内容但读不出来），保存后在桌面标「待补充」
  //   conflicts 桌面同名补充字段已有不同的内容，由用户决定是否替换
  //   notes    不能保存的项和原因；same 桌面已有相同内容的项数（sameIds 是它们的 id）
  function planProfileOffer({ candidates, profile: rawProfile, templateFields = [], limit = MAX_OFFERED_CANDIDATES, stats = null } = {}) {
    const profile = normalizeProfile(rawProfile);
    // 模板和预置字段（含家庭成员）：同名的没法再存成补充字段，存了也会被它们盖住。
    const fixedProfile = { ...profile, custom: [] };
    const fixedValues = new Map();
    mergeResumeFields(templateFields, profileToResumeFields(fixedProfile)).forEach((field) => {
      const id = normalizeKey(field?.key);
      if (id && !fixedValues.has(id)) fixedValues.set(id, text(field.value));
    });
    const fixedKeys = knownFieldKeys(fixedProfile, templateFields);
    const customByKey = new Map(profile.custom.map((item) => [normalizeKey(item.key), item]));

    const rank = (entry) => entry.state === "ready" ? (entry.value ? 3 : 2) : entry.state === "unreadable" ? 1 : 0;
    const merged = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (candidate?.matched) continue;
      const label = candidateLabel(candidate, stats);
      if (!label) continue;
      const state = candidate.state === "stale" ? "stale" : candidate.state === "unreadable" ? "unreadable" : "ready";
      const entry = { id: normalizeKey(label), key: label, state, value: state === "ready" ? text(candidate.value) : "", ambiguous: false };
      const prior = merged.get(entry.id);
      if (!prior) {
        merged.set(entry.id, entry);
      } else if (prior.value && entry.value && !sameValue(prior.value, entry.value)) {
        prior.ambiguous = true;
      } else if (rank(entry) > rank(prior)) {
        merged.set(entry.id, { ...entry, key: prior.key, ambiguous: prior.ambiguous });
      }
    }

    const plan = { filled: [], pending: [], conflicts: [], notes: [], same: 0, sameIds: [], hidden: 0 };
    for (const entry of merged.values()) {
      const { id, key, value } = entry;
      if (entry.ambiguous) { plan.notes.push(skipNote(id, key, "ambiguous")); continue; }
      if (entry.state === "stale") { plan.notes.push(skipNote(id, key, "stale")); continue; }
      if (SECRET_VALUE.test(value)) { plan.notes.push(skipNote(id, key, "secret")); continue; }
      if (value.length > MAX_CANDIDATE_VALUE_CHARS) { plan.notes.push(skipNote(id, key, "too-long")); continue; }
      const hasValue = Boolean(value);
      const unreadable = entry.state === "unreadable";

      if (fixedKeys.has(id)) {
        if (!hasValue) continue;
        const existing = fixedValues.get(id) || "";
        if (existing && sameValue(existing, value)) { plan.same += 1; plan.sameIds.push(id); }
        else plan.notes.push(skipNote(id, key, existing ? "fixed-conflict" : "fixed-empty"));
        continue;
      }

      const listed = plan.filled.length + plan.pending.length + plan.conflicts.length;
      const custom = customByKey.get(id);
      if (custom) {
        const existing = text(custom.value);
        if (!hasValue) { plan.sameIds.push(id); continue; }
        if (existing && sameValue(existing, value)) { plan.same += 1; plan.sameIds.push(id); continue; }
        if (listed >= limit) { plan.hidden += 1; continue; }
        if (existing) plan.conflicts.push({ id, key: custom.key, value, existing });
        else {
          const jobSpecific = JOB_SPECIFIC_LABEL.test(key) || JOB_SPECIFIC_LABEL.test(custom.key)
            || value.length > JOB_SPECIFIC_VALUE_CHARS;
          plan.filled.push({ id, key: custom.key, value, completes: true, jobSpecific, defaultSelected: !jobSpecific });
        }
        continue;
      }

      if (listed >= limit) { plan.hidden += 1; continue; }
      if (hasValue) {
        const jobSpecific = JOB_SPECIFIC_LABEL.test(key) || value.length > JOB_SPECIFIC_VALUE_CHARS;
        plan.filled.push({ id, key, value, completes: false, jobSpecific, defaultSelected: !jobSpecific });
      } else {
        plan.pending.push({ id, key, unreadable });
      }
    }
    return plan;
  }

  function profileOfferSummary(plan) {
    const conflicts = plan?.conflicts?.length || 0;
    return `可保存到我的信息：已填 ${plan?.filled?.length || 0} 项，待补 ${plan?.pending?.length || 0} 项`
      + (conflicts ? `；另有 ${conflicts} 项与桌面已有内容不同` : "");
  }

  function planHasOffer(plan) {
    return Boolean(plan && (plan.filled.length || plan.pending.length || plan.conflicts.length));
  }

  // 没有用户勾选信息时（页面上保留的旧按钮）：按默认勾选的项保存，冲突项从不默认替换。
  function defaultProfileSelection(plan) {
    const pick = (items, kind) => (items || []).filter((item) => item.defaultSelected)
      .map((item) => ({ id: item.id, key: item.key, kind, reviewedValue: item.value ?? "" }));
    return [...pick(plan?.filled, "filled"), ...pick(plan?.pending, "pending")];
  }

  function utf8Length(value) {
    let bytes = 0;
    for (const char of String(value)) {
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }

  // 把用户勾选的项写进档案。plan 必须是点击那一刻按网页当前值和桌面最新档案重算的；
  // selection 每项 { id, key, kind, reviewedValue: 用户看到的网页值, replaceOf: 看到的桌面旧值 }。
  // 看到的和现在的对不上（网页清空了、桌面刚有了别的值）就不写，也不悄悄换成别的：照实报在 skipped 里。
  function applyProfileSelection(rawProfile, plan, selection = []) {
    const profile = normalizeProfile(rawProfile);
    const items = new Map();
    (plan?.filled || []).forEach((item) => items.set(item.id, { ...item, kind: "filled" }));
    (plan?.pending || []).forEach((item) => items.set(item.id, { ...item, kind: "pending" }));
    (plan?.conflicts || []).forEach((item) => items.set(item.id, { ...item, kind: "conflict" }));
    const notes = new Map((plan?.notes || []).map((note) => [note.id, note]));
    const sameIds = new Set(plan?.sameIds || []);

    const saved = [];
    const skipped = [];
    const seenIds = new Set();
    let full = false;
    const skip = (id, key, reason) => skipped.push(skipNote(id, key, reason));
    const fits = () => utf8Length(JSON.stringify(profile)) <= MAX_PROFILE_BYTES;

    for (const choice of Array.isArray(selection) ? selection : []) {
      const id = text(choice?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const item = items.get(id);
      const key = item?.key || notes.get(id)?.key || text(choice?.key) || id;

      if (!item) {
        const note = notes.get(id);
        if (note) skipped.push(note);
        else skip(id, key, sameIds.has(id) ? "same" : "gone");
        continue;
      }

      const seen = choice?.kind;
      if (!["filled", "pending", "conflict"].includes(seen)) { skip(id, key, "value-changed"); continue; }
      if (item.kind === "pending" && (seen === "filled" || seen === "conflict")) { skip(id, key, "cleared"); continue; }
      if (seen !== item.kind) { skip(id, key, seen === "pending" ? "value-changed" : "existing-changed"); continue; }
      if (typeof choice?.reviewedValue !== "string" || choice.reviewedValue !== (item.value ?? "")) {
        skip(id, key, "value-changed");
        continue;
      }
      if (item.kind === "conflict") {
        if (seen !== "conflict" || choice?.replaceOf === undefined) { skip(id, key, seen === "conflict" ? "conflict-unconfirmed" : "existing-changed"); continue; }
        if (!sameValue(choice.replaceOf, item.existing)) { skip(id, key, "existing-changed"); continue; }
      }

      const existing = profile.custom.find((entry) => normalizeKey(entry.key) === id);
      const before = JSON.stringify(profile.custom);
      if (existing) {
        existing.value = item.kind === "pending" ? existing.value : item.value;
      } else {
        if (profile.custom.length >= MAX_CUSTOM_FIELDS) { full = true; skip(id, key, "full"); continue; }
        profile.custom.push({ key: item.key, value: item.kind === "pending" ? "" : item.value });
      }
      if (!fits()) {
        profile.custom = JSON.parse(before);
        full = true;
        skip(id, key, "full");
        continue;
      }
      saved.push({
        id, key: existing?.key || item.key, value: item.kind === "pending" ? "" : item.value,
        kind: item.kind === "pending" ? "pending" : item.kind === "conflict" ? "replaced" : item.completes ? "completed" : "filled"
      });
    }

    return { profile, saved, skipped, full };
  }

  // 保存结果给用户看的话。saved 非空只表示桌面确认写入了这些项；skipped 里的照实列出，不混进「已保存」。
  function describeProfileSave({ saved = [], skipped = [] } = {}) {
    const filled = saved.filter((item) => item.kind !== "pending").length;
    const pending = saved.length - filled;
    const details = skipped.map((item) => item.text);
    if (!saved.length) {
      return { kind: "info", text: skipped.length ? "没有保存任何内容。" : "没有选中要保存的内容。", hint: "", details };
    }
    const kind = skipped.length ? "partial" : "success";
    if (!filled) {
      return { kind, text: `已添加 ${pending} 项待补充字段${skipped.length ? `，另有 ${skipped.length} 项没保存` : ""}。`,
        hint: "它们只存了字段名；到桌面「我的信息」补上内容后，下次填写才能用。", details };
    }
    return {
      kind,
      text: `已保存 ${saved.length} 项，下次填写可用${skipped.length ? `；另有 ${skipped.length} 项没保存` : ""}。`,
      hint: pending ? `其中 ${pending} 项只存了字段名，可稍后到桌面「我的信息」补充内容。` : "",
      details
    };
  }

  function addPendingFields(rawProfile, labels, resumeFields = []) {
    const profile = normalizeProfile(rawProfile);
    const known = knownFieldKeys(profile, resumeFields);
    let added = 0;
    let full = false;

    for (const label of Array.isArray(labels) ? labels : []) {
      const key = text(label);
      const normalized = normalizeKey(key);
      if (!normalized || known.has(normalized) || SECRET_LABEL.test(key)) continue;
      if (profile.custom.length >= MAX_CUSTOM_FIELDS) {
        full = true;
        break;
      }
      known.add(normalized);
      profile.custom.push({ key, value: "" });
      added += 1;
    }

    return { profile, added, full };
  }

  // 设置页表单读出来的一组 { kind, row, field, value }，还原成档案。
  function profileFromEntries(entries) {
    const values = {};
    const family = new Map();
    const custom = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
      const value = String(entry?.value ?? "");

      if (entry?.kind === "value") {
        values[entry.field] = value;
      } else if (entry?.kind === "family") {
        if (!family.has(entry.row)) family.set(entry.row, {});
        family.get(entry.row)[entry.field] = value;
      } else if (entry?.kind === "custom") {
        if (!custom.has(entry.row)) custom.set(entry.row, {});
        custom.get(entry.row)[entry.field] = value;
      }
    }

    return normalizeProfile({ values, family: [...family.values()], custom: [...custom.values()] });
  }

  function isSameMember(left, right) {
    if (left.relation !== right.relation) return false;
    if (SINGLE_RELATIONS.has(left.relation)) return true;
    return Boolean(left.name) && normalizeKey(left.name) === normalizeKey(right.name);
  }

  // 备份追加时用：本机已经填了的不动，只补本机空着的。
  function mergeProfiles(localProfile, incomingProfile) {
    const local = normalizeProfile(localProfile);
    const incoming = normalizeProfile(incomingProfile);

    const values = { ...incoming.values, ...local.values };

    const family = local.family.map((member) => ({ ...member }));
    incoming.family.forEach((member) => {
      const match = family.find((existing) => isSameMember(existing, member));
      if (!match) {
        family.push({ ...member });
        return;
      }
      FAMILY_FIELDS.forEach((field) => {
        if (!match[field.id] && member[field.id]) match[field.id] = member[field.id];
      });
    });

    const custom = local.custom.map((item) => {
      if (item.value) return item;
      const match = incoming.custom.find((other) => normalizeKey(other.key) === normalizeKey(item.key));
      return match?.value ? { key: item.key, value: match.value } : item;
    });
    const localKeys = new Set(local.custom.map((item) => normalizeKey(item.key)));
    incoming.custom.forEach((item) => {
      if (!localKeys.has(normalizeKey(item.key))) custom.push(item);
    });

    return normalizeProfile({ values, family, custom });
  }

  const api = {
    CUSTOM_GROUP,
    SECRET_LABEL,
    SECRET_VALUE,
    FAMILY_FIELDS,
    FAMILY_GROUP,
    FAMILY_RELATIONS,
    PROFILE_SCHEMA,
    MAX_OFFERED_CANDIDATES,
    addPendingFields,
    applyProfileSelection,
    countPendingFields,
    countProfileValues,
    defaultProfileSelection,
    describeProfileSave,
    emptyProfile,
    hasProfileContent,
    knownFieldKeys,
    mergeProfiles,
    mergeResumeFields,
    normalizeProfile,
    pickUnansweredLabels,
    planHasOffer,
    planProfileOffer,
    profileFromEntries,
    profileOfferSummary,
    profileToResumeFields,
    stripProfileSecrets
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.ResumeProProfile = api;
})(typeof self !== "undefined" ? self : globalThis);
