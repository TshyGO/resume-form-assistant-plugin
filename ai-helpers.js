(function attachResumeProAIHelpers(globalScope) {
  const GENERIC_ENTITY_PATTERN = /^([\u4e00-\u9fa5A-Za-z]+?)(\d+)([\u4e00-\u9fa5A-Za-z].*)$/;
  const ENTITY_LABEL_BY_GROUP = [
    { pattern: /教育/, label: "教育经历" },
    { pattern: /实习/, label: "实习经历" },
    { pattern: /工作/, label: "工作经历" },
    { pattern: /科研/, label: "科研经历" },
    { pattern: /校园/, label: "校园经历" },
    { pattern: /项目/, label: "项目经历" },
    { pattern: /论文/, label: "论文" },
    { pattern: /专利/, label: "专利" },
    { pattern: /证书/, label: "证书" },
    { pattern: /奖励/, label: "奖励" }
  ];

  const FIELD_SEMANTICS = [
    { type: "pinyin", keywords: ["拼音", "pinyin"] },
    { type: "email", keywords: ["邮箱", "email", "e-mail", "mail"] },
    { type: "phone", keywords: ["手机", "电话", "联系方式", "mobile", "phone", "联系电话"] },
    { type: "gender", keywords: ["性别", "gender"] },
    { type: "birth_date", keywords: ["出生日期", "生日", "birth", "出生年月"] },
    { type: "name", keywords: ["姓名", "name", "realname"] },
    { type: "id_number", keywords: ["身份证", "证件号码", "证件号", "idnumber", "身份证号"] },
    { type: "hometown", keywords: ["籍贯", "生源地", "户口", "户籍", "nativeplace", "hometown", "hukou"] },
    { type: "region", keywords: ["国家/地区", "国家地区", "country", "region", "地区"] },
    { type: "major", keywords: ["专业", "major"] },
    { type: "school", keywords: ["学校", "院校", "大学", "学院", "school", "university"] },
    { type: "degree", keywords: ["学历", "学位", "培养层次", "degree"] }
  ];
  // 关键词先 normalize 好：本地匹配里每一对网页字段和简历字段都要查这张表。
  const SEMANTIC_KEYWORDS = FIELD_SEMANTICS.map((item) => ({ type: item.type, keywords: item.keywords.map(normalizeText) }));
  // 表里没有、但看得出是别的号码的简历字段名：不是手机也不是证件号，不按值去猜。
  const OTHER_NUMBER_KEY = /微信|wechat|qq|学号|学生证|工号|准考证|考生号|报名号|学籍|证书|编号|卡号|账号|帐号|邮编|邮政编码/;
  // 字段名认不出、只能按值猜手机和证件号时用（isResumeFieldMatch）。
  const MOBILE_VALUE = /^(\+?86)?1[3-9]\d{9}$/;
  const CN_ID_VALUE = /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dxX]$/;

  // #429 下拉、单选的选项和资料是同一个意思的不同写法，又不是包含关系（「汉族」对「汉」、「共青团员」对「中国共产主义青年团团员」）。
  // 每组是同一个意思的几种写法，选项里正好一项是同组的另一种写法才用它（findSelectOptionIndex）。只收确定同义的：
  // 学历和学位不混（「本科」不等于「学士」）；「群众」和「无党派人士」在国标（GB/T 4762）里是两项；
  // 「港澳通行证」也可能是内地居民往来港澳通行证，不当成回乡证。一种写法只能在一组里（tests/ai-helpers.test.js 查）。
  const ETHNIC_NAMES = ("汉 蒙古 回 藏 维吾尔 苗 彝 壮 布依 朝鲜 满 侗 瑶 白 土家 哈尼 哈萨克 傣 黎 傈僳 佤 畲 高山 拉祜 水 东乡 纳西 景颇 柯尔克孜 土 "
    + "达斡尔 仫佬 羌 布朗 撒拉 毛南 仡佬 锡伯 阿昌 普米 塔吉克 怒 乌孜别克 俄罗斯 鄂温克 德昂 保安 裕固 京 塔塔尔 独龙 鄂伦春 赫哲 门巴 珞巴 基诺").split(" ");
  const OPTION_SYNONYMS = [
    // 证件类型（#418）：「我的信息」写全称（profile-fields.js），网站常写简称，旁边还有「香港居民身份证」这类。
    ["居民身份证", "身份证", "中国居民身份证", "中华人民共和国居民身份证", "大陆居民身份证", "二代身份证"],
    ["港澳居民来往内地通行证", "回乡证"],
    ["台湾居民来往大陆通行证", "台胞证"],
    // 政治面貌：国标全称（GB/T 4762）、常用简称。
    ["中共党员", "中国共产党党员", "共产党员", "党员"],
    ["中共预备党员", "中国共产党预备党员", "预备党员"],
    ["共青团员", "中国共产主义青年团团员", "团员"],
    ["民革会员", "中国国民党革命委员会会员"],
    ["民盟盟员", "中国民主同盟盟员"],
    ["民建会员", "中国民主建国会会员"],
    ["民进会员", "中国民主促进会会员"],
    ["农工党党员", "中国农工民主党党员"],
    ["致公党党员", "中国致公党党员"],
    ["台盟盟员", "台湾民主自治同盟盟员"],
    ["无党派人士", "无党派民主人士", "无党派"],
    // 民族（GB/T 3304 的 56 个民族）：带不带「族」字。
    ...ETHNIC_NAMES.map((name) => [`${name}族`, name]),
    // 学历：只收学历自己的写法，「硕士」「博士」也是学位，不放进来。
    ["大学本科", "本科"],
    ["大学专科", "专科", "大专"],
    // 外语等级。
    ["CET-4", "大学英语四级", "英语四级", "四级"],
    ["CET-6", "大学英语六级", "英语六级", "六级"],
    ["TEM-4", "专业英语四级", "英语专业四级", "专四"],
    ["TEM-8", "专业英语八级", "英语专业八级", "专八"],
    // 性别：英文表单。
    ["男", "男性", "Male"],
    ["女", "女性", "Female"]
    // 「中国」不当成「中国大陆」：港澳台居民的国籍也是中国，选项把港澳台分开列时照旧不选。
  ];
  const SYNONYM_GROUPS = new Map();
  for (const names of OPTION_SYNONYMS) {
    const group = { names, normalized: new Set(names.map(normalizeText)) };
    for (const name of group.normalized) if (!SYNONYM_GROUPS.has(name)) SYNONYM_GROUPS.set(name, group);
  }

  function detectCascadeGroups(fields, fieldMap) {
    const selectFields = fields.filter((f) => f.tagName === "select");
    let cascadeGroupIndex = 0;
    const processedSelectIDs = new Set();
    const locationRegex = /(省|市|区|county|city|province)/i;

    selectFields.forEach((currentField) => {
      if (processedSelectIDs.has(currentField.fieldId)) {
        return;
      }

      const currentElement = fieldMap.get(currentField.fieldId)?.element;
      if (!currentElement) return;

      let parent = currentElement.parentElement;
      let depth = 0;

      while (parent && depth < 5) {
        const validSelectFieldsInParent = selectFields.filter((f) => {
          const el = fieldMap.get(f.fieldId)?.element;
          return el && parent.contains(el);
        });

        if (validSelectFieldsInParent.length > 1) {
          const hasLocationKeywords = validSelectFieldsInParent.some((f) =>
            locationRegex.test(f.name) || locationRegex.test(f.idAttr) || locationRegex.test(f.ariaLabel) || locationRegex.test(f.label)
          );

          let isCascade = hasLocationKeywords;

          if (!isCascade) {
             for (let i = 1; i < validSelectFieldsInParent.length; i++) {
               if (validSelectFieldsInParent[i].options.length <= 1) {
                 isCascade = true;
                 break;
               }
             }
          }

          if (isCascade) {
            const isKeywordBased = hasLocationKeywords;
            let cascadeSelects;
            if (isKeywordBased) {
              cascadeSelects = validSelectFieldsInParent.filter((f) =>
                locationRegex.test(f.name) || locationRegex.test(f.idAttr) ||
                locationRegex.test(f.ariaLabel) || locationRegex.test(f.label) ||
                f.options.length <= 1
              );
            } else {
              const firstSparseIndex = validSelectFieldsInParent.findIndex((f, i) => i > 0 && f.options.length <= 1);
              cascadeSelects = firstSparseIndex > 0
                ? validSelectFieldsInParent.filter((f, i) =>
                    i === firstSparseIndex - 1 || (i >= firstSparseIndex && f.options.length <= 1)
                  )
                : [];
            }
            if (cascadeSelects.length > 1) {
              cascadeSelects.forEach((f, idx) => {
                f.cascadeGroup = `group-${cascadeGroupIndex}`;
                f.cascadeLevel = idx;
                processedSelectIDs.add(f.fieldId);
              });
              cascadeGroupIndex++;
            }
            break;
          }
        }
        parent = parent.parentElement;
        depth++;
      }
    });
  }

  const helpers = {
    normalizeText,
    inferFieldSemantic,
    buildRuleBasedMatches,
    isSecretFormField,
    isSafeResumeField,
    localRuleMatches,
    selectResumeCandidates,
    findSelectOptionIndex,
    isSameOptionText,
    optionSearchText,
    isPlaceholderOption,
    filterValidMatches,
    semanticizeParsedFields,
    normalizeParsedFields,
    normalizeDateValue,
    rangeDateValue,
    detectCascadeGroups
  };

  globalScope.ResumeProAIHelpers = helpers;

  try {
    if (typeof module === "object" && module && typeof module.exports === "object") {
      module.exports = helpers;
    }
  } catch {
    // A page element or frame named "module" (#275).
  }

  function normalizeText(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[\s:：*（）()【】\[\]\-_/.]+/g, "");
  }

  // 只看字段自己的文字：group 是所属区块（「联系方式」「家庭成员」），会把「地址」「QQ」也带成电话。
  // 区块只用来分清是谁的字段（personScope）。
  function inferFieldSemantic(field) {
    const haystack = normalizeText([
      field?.label,
      field?.placeholder,
      field?.name,
      field?.idAttr,
      field?.ariaLabel
    ].filter(Boolean).join(" "));

    return SEMANTIC_KEYWORDS.find((item) => item.keywords.some((keyword) => haystack.includes(keyword)))?.type || "";
  }

  // 简历字段名是哪一类：先查 FIELD_SEMANTICS，再认 DOB 这类缩写（整个名字才算，Adobe 不算）和别的号码。
  // 认不出返回空串。只看字段名不看分组，和 inferFieldSemantic 一样：分组「联系方式」会把整组都认成电话。
  function resumeKeyType(key) {
    const type = inferFieldSemantic({ label: key });
    if (type) return type;
    const text = normalizeText(key);
    if (/^(dob|born)$/.test(text)) return "birth_date";
    return OTHER_NUMBER_KEY.test(text) ? "other" : "";
  }

  // Keep complete groups (including every repeated experience). Unknown or
  // cross-domain labels deliberately fall back to the full resume.
  function selectResumeCandidates(formFields, resumeFields) {
    const domains = [
      /教育|学校|院校|研究生|硕士|博士|专业|学历|学位|入学|毕业|education|school|university|major|degree|postgraduate/i,
      /工作经历|实习|任职经历|工作内容|工作单位|公司|雇主|\bwork\s+(?:history|experience)\b|\bemployment\b|\binternship\b|\bcompany\b/i,
      /项目|科研|研究经历|\bproject\b|\bresearch\b/i,
      /论文|专利|发表|publication|patent/i,
      /证书|奖励|奖项|荣誉|certificate|award/i,
      /技能|语言能力|skill|language/i,
      /基本信息|个人信息|姓名|电话|邮箱|籍贯|personal|contact/i
    ];
    const classify = (text) => domains.flatMap((pattern, i) => pattern.test(text) ? [i] : []);
    const selected = new Set();
    for (const field of formFields) {
      const context = [field.group, field.label, field.placeholder, field.name, field.ariaLabel].filter(Boolean).join(" ");
      // Eligibility/location questions are not employment-history questions.
      if (/authoriz|eligib|sponsor|visa|work\s*(?:permit|location)|career\s*plan|工作许可|工作授权|工作地点|工作计划|职业规划|求职意向|就业资格|签证/i.test(context)) return resumeFields;
      const categories = classify(context);
      if (categories.length !== 1) return resumeFields;
      const category = categories[0];
      if (!resumeFields.some(item => classify(String(item.group || "")).includes(category))) return resumeFields;
      const relevant = resumeFields.filter((item) => {
        const groups = classify(String(item.group || ""));
        // Custom groups cannot safely be ruled out.
        // Current employer/role and similar facts may live in basic info.
        return !groups.length || groups.includes(6) || groups.includes(category);
      });
      if (!relevant.length) return resumeFields;
      relevant.forEach((item) => selected.add(item));
    }
    return resumeFields.filter((item) => selected.has(item));
  }

  function buildRuleBasedMatches(formFields, resumeFields) {
    const strongTypes = new Set(["name", "email", "phone", "gender", "birth_date", "id_number", "hometown", "region"]);
    const matches = [];
    const usedResumeIndexes = new Set();
    // 简历字段名的类别每项只算一次，用到时才算。
    const keyTypes = new Map();
    const keyTypeOf = (index) => {
      if (!keyTypes.has(index)) keyTypes.set(index, resumeKeyType(resumeFields[index]?.key));
      return keyTypes.get(index);
    };

    formFields.forEach((field) => {
      const semantic = inferFieldSemantic(field);

      if (!strongTypes.has(semantic)) {
        return;
      }

      const formScope = personScope(fieldContextText(field));
      const matchIndex = resumeFields.findIndex((resumeField, index) => {
        if (usedResumeIndexes.has(index)) {
          return false;
        }

        if (!isSamePersonScope(resumeField, formScope) || !isResumeFieldMatch(semantic, resumeField, field, () => keyTypeOf(index))) {
          return false;
        }

        // 语义对得上、但值这个字段收不下的（下拉里没有这个选项），不能占住位置，接着往后找。
        return isValueValidForField(field, resumeField.value);
      });

      if (matchIndex >= 0) {
        matches.push({
          fieldId: field.fieldId,
          value: resumeFields[matchIndex].value
        });
        usedResumeIndexes.add(matchIndex);
      }
    });

    return matches;
  }

  // 像密码的网页字段和简历资料不参与匹配，也不发给 AI。profile 是 profile-fields.js（ResumeProProfile）。
  function isSecretFormField(field, profile) {
    return String(field?.inputType ?? "").toLowerCase() === "password"
      || profile.SECRET_LABEL.test([field?.label, field?.name, field?.key].filter(Boolean).join(" "));
  }

  function isSafeResumeField(field, profile) {
    return !profile.SECRET_LABEL.test(String(field?.key ?? ""))
      && !profile.SECRET_VALUE.test(String(field?.value ?? ""));
  }

  // 本地规则的匹配结果（#402）：worker 的 ruleMatches 和网页先填的字段用同一份口径。
  function localRuleMatches(formFields, resumeFields, profile) {
    const forms = formFields.filter((field) => !isSecretFormField(field, profile));
    const resume = resumeFields.filter((field) => isSafeResumeField(field, profile));
    return filterValidMatches(forms, buildRuleBasedMatches(forms, resume));
  }

  function filterValidMatches(formFields, matches) {
    const formFieldMap = new Map(formFields.map((field) => [field.fieldId, field]));

    return matches.filter((match) => {
      const formField = formFieldMap.get(match.fieldId);

      if (!formField) {
        return false;
      }

      return isValueValidForField(formField, match.value);
    });
  }

  function fieldContextText(field) {
    return normalizeText([
      field?.group,
      field?.label,
      field?.placeholder,
      field?.name,
      field?.idAttr,
      field?.ariaLabel
    ].filter(Boolean).join(" "));
  }

  // 紧急联系人、父亲、母亲、配偶是不同的人：本人的字段不取他们的值，他们的字段也不取本人的值。
  // 工行把紧急联系人放在「个人基本信息」分组下，只看字段语义会把本人的姓名和手机号填进去。
  // 「家庭成员」这类不知道具体是谁的，只用来挡住本人的值，本地规则不替它挑人。
  function personScope(text) {
    const source = String(text ?? "");
    const tags = [];

    // 传进来的是 normalizeText 之后的文字：小写、没有空格，英文词是连在一起的。
    if (/紧急联系|紧急联络|紧急电话|应急联系|监护人|emergencycontact|emergencyphone|guardian/.test(source)) tags.push("contact");
    if (/父亲|爸爸|father/.test(source)) tags.push("father");
    if (/母亲|妈妈|mother/.test(source)) tags.push("mother");
    if (/配偶|妻子|丈夫|爱人|spouse|wife|husband/.test(source)) tags.push("spouse");
    if (/家庭(?:主要)?成员|家属|家人|亲属|父母|兄弟|姐妹|子女|familymember|relative|sibling/.test(source)) tags.push("relative");

    return tags;
  }

  function isSamePersonScope(resumeField, formScope) {
    const resumeScope = personScope(normalizeText([resumeField?.group, resumeField?.key].filter(Boolean).join(" ")));

    if (!formScope.length && !resumeScope.length) {
      return true;
    }

    if (!formScope.length || !resumeScope.length) {
      return false;
    }

    return formScope.some((tag) => tag !== "relative" && resumeScope.includes(tag));
  }

  // 下拉框、单选框选值：先精确，再归一化，最后「包含」。
  // 网页选项和资料写法常对不上（本科 / 大学本科），只做全等会让大量下拉框填不上。
  // 「包含」只在唯一命中时采用：「博士」同时包含于「博士研究生」和「博士后」时宁可不选。
  function findSelectOptionIndex(options, value) {
    const list = Array.isArray(options) ? options : [];
    const target = String(value ?? "").trim();

    if (!target || !list.length) {
      return -1;
    }

    const isObject = (option) => typeof option === "object" && option !== null;
    const optionValue = (option) => String(isObject(option) ? option.value ?? "" : option ?? "").trim();
    const optionText = (option) => String(isObject(option) ? option.text ?? "" : option ?? "").trim();
    // 占位项和禁用项每一步都不算：值恰好就是「请选择」也不能当成填上了。
    const usable = list
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !isPlaceholderOption(option));
    const findUsable = (test) => usable.find(({ option }) => test(option))?.index ?? -1;

    let index = findUsable((option) => optionValue(option) === target);
    if (index >= 0) return index;

    index = findUsable((option) => optionText(option) === target);
    if (index >= 0) return index;

    const normalizedTarget = normalizeText(target);
    if (!normalizedTarget) return -1;

    index = findUsable((option) => normalizeText(optionText(option)) === normalizedTarget
      || normalizeText(optionValue(option)) === normalizedTarget);
    if (index >= 0) return index;

    // 同一个意思的另一种写法（见 OPTION_SYNONYMS）：选项里正好一项是才用它，几项都是就照下面的规则。
    const names = SYNONYM_GROUPS.get(normalizedTarget)?.normalized;
    const synonyms = names ? usable.filter(({ option }) => names.has(normalizeText(optionText(option))) || names.has(normalizeText(optionValue(option)))) : [];
    if (synonyms.length === 1) return synonyms[0].index;

    // 「全日制」不能落到「非全日制」，反过来也一样。
    const negatedBefore = (text, at) => /(非|不|无|未)$/.test(text.slice(0, at));
    const candidates = usable.flatMap(({ option, index: optionIndex }) => {
      const text = normalizeText(optionText(option));

      if (text.length < 2) {
        return [];
      }

      const inOption = text.indexOf(normalizedTarget);
      if (inOption >= 0) {
        return negatedBefore(text, inOption) ? [] : [optionIndex];
      }

      const inTarget = normalizedTarget.indexOf(text);
      if (inTarget >= 0) {
        return negatedBefore(normalizedTarget, inTarget) ? [] : [optionIndex];
      }

      return [];
    });

    return candidates.length === 1 ? candidates[0] : -1;
  }

  // 选项文字和要填的值是不是同一项：归一化后相同，或是同一个意思的另一种写法（OPTION_SYNONYMS）。
  // 虚拟列表只画出一部分时只认这样的一项（custom-controls.js 的 match）。
  function isSameOptionText(text, value) {
    const a = normalizeText(text);
    const b = normalizeText(value);
    if (!a || !b) return false;
    return a === b || Boolean(SYNONYM_GROUPS.get(b)?.normalized.has(a));
  }

  // 下拉框里搜索时打的字：要填的值有别的写法、且每种写法都含着其中最短的一种时打这一种
  // （「土家族」打「土家」，选项写「土家」也搜得到），否则照原样打。
  function optionSearchText(value) {
    const raw = String(value ?? "").trim();
    const group = SYNONYM_GROUPS.get(normalizeText(raw));
    if (!group) return raw;
    const core = group.names
      .filter((name) => Array.from(group.normalized).every((other) => other.includes(normalizeText(name))))
      .sort((a, b) => a.length - b.length)[0];
    return core || raw;
  }

  // 籍贯、高考生源地、户口所在地是三个问题，不能互相顶替；同一个问题下的省、市、县也要分清。
  function regionTopic(text) {
    if (/生源地/.test(text)) return "origin";
    if (/户口|户籍|hukou/.test(text)) return "hukou";
    if (/籍贯|nativeplace|hometown/.test(text)) return "native";
    return "";
  }

  function regionLevel(text) {
    // 「地区」「区域」里的「区」不是区县。
    const source = String(text ?? "").replace(/地区|区域/g, "");

    if (/省|自治区|province/.test(source)) return "province";
    if (/市|city/.test(source)) return "city";
    if (/县|区|county|district/.test(source)) return "county";
    return "";
  }

  function isSameRegionTopic(resumeField, formField) {
    // 两边都是先看字段自己的文字，看不出来才看分组：分组名「户籍与地区」不能把「籍贯」判成户口。
    const keyText = normalizeText(resumeField?.key);
    const keyTopic = regionTopic(keyText) || regionTopic(normalizeText(resumeField?.group));

    if (!keyTopic) {
      return false;
    }

    const ownText = normalizeText([
      formField?.label,
      formField?.placeholder,
      formField?.name,
      formField?.idAttr,
      formField?.ariaLabel
    ].filter(Boolean).join(" "));
    const groupText = normalizeText(formField?.group);

    // 「户口性质」「户籍类型」问的不是地方，只接受字段名一模一样的那一项。
    if (/性质|类型|类别/.test(ownText)) {
      return Boolean(keyText) && keyText === normalizeText(formField?.label);
    }

    const formTopic = regionTopic(ownText) || regionTopic(groupText);

    if (formTopic && formTopic !== keyTopic) {
      return false;
    }

    const keyLevel = regionLevel(keyText);
    const formLevel = regionLevel(ownText) || regionLevel(groupText);

    return !(keyLevel && formLevel && keyLevel !== formLevel);
  }

  function semanticizeParsedFields(fields) {
    const buckets = new Map();

    fields.forEach((field, index) => {
      const parsed = parseGenericKey(field.group, field.key);
      const bucketKey = parsed ? `${field.group}::${parsed.entityType}::${parsed.index}` : `raw::${index}`;

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { parsed, items: [] });
      }

      buckets.get(bucketKey).items.push({ ...field, sourceIndex: index });
    });

    const renamed = [];
    const seenKeys = new Map();

    buckets.forEach(({ parsed, items }) => {
      const anchor = parsed ? findAnchorValue(items, parsed, parsed.groupName) : "";
      const entityLabel = parsed ? resolveEntityLabel(parsed.groupName, parsed.entityType) : "";

      items.forEach((item) => {
        let nextKey = item.key;

        if (parsed) {
          const detail = sanitizeDetail(parsed, item.key);
          const prefix = anchor ? `${anchor}${entityLabel}` : entityLabel;

          if (prefix) {
            nextKey = detail ? `${prefix}-${detail}` : prefix;
          }
        }

        nextKey = uniquifyKey(nextKey, seenKeys);
        renamed.push({
          group: item.group,
          key: nextKey,
          value: item.value
        });
      });
    });

    return renamed;
  }

  function normalizeParsedFields(payload) {
    if (!Array.isArray(payload)) {
      throw new Error("结果不是 JSON 数组。");
    }

    return semanticizeParsedFields(
      payload
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const group = String(item.group ?? "").trim();
          const key = String(item.key ?? "").trim();
          const value = String(item.value ?? "");

          if (!group || !key) {
            return null;
          }

          return { group, key, value };
        })
        .filter(Boolean)
    );
  }

  // 占位项和禁用项：「请选择」「--」这类，以及 disabled 的选项。
  function isPlaceholderOption(option) {
    const isObject = typeof option === "object" && option !== null;

    if (isObject && option.disabled) {
      return true;
    }

    const text = String(isObject ? option.text ?? "" : option ?? "").trim();
    // 单独的「选择」才算占位，「选择其他」是正经选项；英文的 Select… / Choose… 开头都算。
    return /^(请选择|请输入|please\s*(select|choose)|select\b|choose\b|--|—)|^选择$/i.test(text);
  }

  function isResumeFieldMatch(semantic, resumeField, formField, keyType = () => resumeKeyType(resumeField?.key)) {
    const keyText = normalizeText([resumeField?.group, resumeField?.key].filter(Boolean).join(" "));
    const value = String(resumeField?.value ?? "").trim();
    const ownKey = normalizeText(resumeField?.key);
    // 字段名自己带着「手机」「证件」这类词就算，哪怕它归到了别的类（「证件编号」算别的号码，「手机/邮箱」算邮箱）。
    // 不带的，字段名认得出是哪一类（微信、准考证号、姓名）就只按名字算，认不出的（自定义的「号码1」）才看分组名和值：
    // 手机号也是 8 到 18 位数字，纯数字的身份证号也像电话，按值算会让排在前面的那项填进另一个框；
    // 分组名同理，「证件信息」下的准考证号、「手机与微信」下的微信不是证件号码和手机。
    const byKeyName = (words, valueFits) => {
      if (words.some((word) => ownKey.includes(word))) return true;
      const type = keyType();
      return type ? type === semantic : words.some((word) => keyText.includes(word)) || valueFits();
    };
    // 按值猜时，明确是大陆手机号的不当证件号，明确是 18 位身份证号的不当电话：「号码1」「号码2」谁排前面都不互相顶替。
    const compact = value.replace(/[\s-]/g, "");

    switch (semantic) {
      case "name":
        // 分组名只给认不出的字段名用（分组「姓名」下的「中文」）；schoolName 这类认作别的类，不看分组。
        return (ownKey.includes("姓名") || (!keyType() && keyText.includes("姓名"))) && !keyText.includes("拼音");
      case "email":
        return /@/.test(value) || keyText.includes("邮箱") || keyText.includes("email");
      case "phone":
        return byKeyName(["手机", "电话"], () => /^(\+?\d[\d\s-]{7,})$/.test(value) && !CN_ID_VALUE.test(compact));
      case "gender":
        // 按值猜只收整个值就是性别的，带「女」字的经历描述不算。
        return byKeyName(["性别"], () => /^(男|女|男性|女性|male|female)$/i.test(value));
      case "birth_date":
        // 日期看不出是谁的：毕业时间、实习起止时间也是这个样子，出生日期只按名字认。
        return /出生|生日|birth/.test(ownKey) || keyType() === "birth_date";
      case "id_number":
        return byKeyName(["身份证", "证件"], () => /^[0-9xX]{8,18}$/.test(value.replace(/\s/g, "")) && !MOBILE_VALUE.test(compact));
      case "hometown":
        return isSameRegionTopic(resumeField, formField);
      case "region":
        return keyText.includes("国家") || keyText.includes("地区");
      default:
        return false;
    }
  }

  function isValueValidForField(field, value) {
    const text = String(value ?? "").trim();
    const semantic = inferFieldSemantic(field);

    if (!text) {
      return false;
    }

    // 只有「请选择」、选项还没加载出来的下拉框（没被识别成联动组的下一级）这里不判，
    // 交给页面填写时等选项出来再选；否则值在这里就被丢掉，页面上的重试拿不到东西。
    const hasRealOptions = Array.isArray(field?.options)
      && field.options.some((option) => !isPlaceholderOption(option) && String(typeof option === "object" && option !== null ? option.text ?? "" : option ?? "").trim());

    if ((field?.inputType === "select" || field?.inputType === "radio") && hasRealOptions && field?.cascadeGroup === undefined) {
      // 和网页上实际选值用同一套规则，否则页面能选上的值会先在这里被丢掉。
      if (findSelectOptionIndex(field.options, text) < 0) {
        return false;
      }
    }

    switch (semantic) {
      case "pinyin":
        return /^[A-Za-z\s]+$/.test(text);
      case "email":
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
      case "phone":
        return /^[+\d][\d\s-]{6,}$/.test(text);
      case "birth_date":
        return /(\d{4}[-/.年]\d{1,2}([-/.\月]\d{1,2}日?)?)/.test(text);
      case "gender":
        return /(男|女|male|female)/i.test(text);
      case "id_number":
        return /^[0-9xX]{8,18}$/.test(text.replace(/\s/g, ""));
      case "name":
        return text.length <= 20 && !/@/.test(text) && !/\d{5,}/.test(text);
      case "hometown":
        return !/(硕|博|学位|专业|邮箱|电话|手机)/.test(text);
      default:
        return true;
    }
  }

  function parseGenericKey(groupName, key) {
    const match = String(key ?? "").trim().match(GENERIC_ENTITY_PATTERN);

    if (!match) {
      return null;
    }

    return {
      groupName,
      entityType: match[1],
      index: match[2],
      detail: match[3]
    };
  }

  function findAnchorValue(items, parsed, groupName) {
    const preferredKeywords = resolveAnchorKeywords(groupName, parsed.entityType);
    const preferredField = items.find((item) => preferredKeywords.some((keyword) => normalizeText(item.key).includes(normalizeText(keyword))) && item.value);

    if (preferredField) {
      return sanitizeAnchor(preferredField.value);
    }

    const fallbackField = items.find((item) => item.value);
    return fallbackField ? sanitizeAnchor(fallbackField.value) : "";
  }

  function resolveAnchorKeywords(groupName, entityType) {
    if (/教育/.test(groupName)) {
      return ["学校", "院校", "大学", "学院"];
    }

    if (/实习|工作/.test(groupName)) {
      return ["公司", "单位", "组织", "机构"];
    }

    if (/科研/.test(groupName)) {
      return ["课题", "实验室", "项目", "单位"];
    }

    if (/校园/.test(groupName)) {
      return ["组织", "社团", "部门", "单位"];
    }

    if (/项目/.test(groupName)) {
      return ["项目", "名称", "标题"];
    }

    if (/论文|专利|证书|奖励/.test(groupName)) {
      return ["标题", "名称", "奖项"];
    }

    return ["名称", "标题", "公司", "学校", "单位"];
  }

  function resolveEntityLabel(groupName, entityType) {
    return ENTITY_LABEL_BY_GROUP.find((item) => item.pattern.test(groupName))?.label || `${entityType}信息`;
  }

  function sanitizeDetail(parsed, originalKey) {
    return String(originalKey)
      .replace(GENERIC_ENTITY_PATTERN, "$3")
      .replace(/^(公司名|公司|单位|学校|院校|大学|学院|岗位名称|岗位|职位名称|职位|项目名称|项目|论文标题|标题|名称)/, (match) => match)
      .replace(/^[\s\-_:：]+/, "")
      .trim();
  }

  function sanitizeAnchor(value) {
    return String(value ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 18);
  }

  function uniquifyKey(key, seenKeys) {
    const base = key || "未命名字段";
    const count = seenKeys.get(base) || 0;
    seenKeys.set(base, count + 1);
    return count ? `${base} (${count + 1})` : base;
  }

  function normalizeDateValue(rawValue, inputType) {
    const raw = String(rawValue ?? "").trim();

    const parsed = parseDateParts(raw);

    if (!parsed) {
      return raw;
    }

    const { year, month, day, hour, minute } = parsed;

    switch (inputType) {
      case "date":
        if (!year || !month || !day) return raw;
        return `${year}-${pad2(month)}-${pad2(day)}`;
      case "month":
        if (!year || !month) return raw;
        return `${year}-${pad2(month)}`;
      case "time":
        if (hour === null || minute === null) return raw;
        return `${pad2(hour)}:${pad2(minute)}`;
      case "datetime-local":
        if (!year || !month || !day) return raw;
        return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour ?? 0)}:${pad2(minute ?? 0)}`;
      default:
        return raw;
    }
  }

  // 日期题收到一段起止（「2019.09-2023.06」，#301 北森）：题目或占位提示写明开始还是结束，就取前一个或后一个日期。
  // 两样都写了（起止时间）、都没写，或不是正好两个日期的，原样交回，由日期控件报日期不对。
  const SPAN_DATE = /(?:19|20)\d{2}(?:\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|\s*[\/\-.]\s*\d{1,2}(?!\d)(?:\s*[\/\-.]\s*\d{1,2}(?!\d))?|\s*年)?/g;
  // 「起」「止」单独成词才算（「在校时间（起）」「在校时间：止」）：「发起」「起薪」「禁止」里的不算。
  const SPAN_START = /开始|起始|入学|入职|(?:^|[\s(（【\[:：])起(?=$|[\s)）】\]:：])|\b(?:start|from|begin)/i;
  const SPAN_END = /结束|截止|终止|毕业|离职|(?:^|[\s(（【\[:：])止(?=$|[\s)）】\]:：])|\b(?:end|until)\b/i;
  function rangeDateValue(rawValue, hint) {
    const raw = String(rawValue ?? "").trim();
    const dates = raw.match(SPAN_DATE) || [];
    if (dates.length !== 2 || raw.replace(SPAN_DATE, "").replace(/[\s\-~～—–至到]/g, "")) return raw;
    const text = String(hint ?? "");
    const start = SPAN_START.test(text), end = SPAN_END.test(text);
    return start === end ? raw : dates[start ? 0 : 1].trim();
  }

  function parseDateParts(raw) {
    if (/(19|20)\d{2}.+(19|20)\d{2}/.test(raw)) return null;

    const chineseMatch = raw.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?(?:[T\s](\d{1,2}):(\d{1,2}))?/);
    if (chineseMatch) {
      return {
        year: chineseMatch[1],
        month: chineseMatch[2],
        day: chineseMatch[3] || null,
        hour: chineseMatch[4] != null ? chineseMatch[4] : null,
        minute: chineseMatch[5] != null ? chineseMatch[5] : null
      };
    }

    // 分隔符两边可以带空格（「2019 - 09」「2019. 09」，#301 北森）。
    const separatorMatch = raw.match(/^(\d{4})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{1,2})(?!\d))?(?:[T\s](\d{1,2}):(\d{1,2}))?/);
    if (separatorMatch) {
      return {
        year: separatorMatch[1],
        month: separatorMatch[2],
        day: separatorMatch[3] || null,
        hour: separatorMatch[4] != null ? separatorMatch[4] : null,
        minute: separatorMatch[5] != null ? separatorMatch[5] : null
      };
    }

    const timeMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      return {
        year: null,
        month: null,
        day: null,
        hour: timeMatch[1],
        minute: timeMatch[2]
      };
    }

    return null;
  }

  function pad2(value) {
    return String(Number(value)).padStart(2, "0");
  }
})(typeof self !== "undefined" ? self : globalThis);
