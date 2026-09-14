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
    selectResumeCandidates,
    findSelectOptionIndex,
    filterValidMatches,
    semanticizeParsedFields,
    normalizeParsedFields,
    normalizeDateValue,
    detectCascadeGroups
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }

  globalScope.ResumeProAIHelpers = helpers;

  function normalizeText(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[\s:：*（）()【】\[\]\-_/.]+/g, "");
  }

  function inferFieldSemantic(field) {
    const haystack = normalizeText([
      field?.group,
      field?.label,
      field?.placeholder,
      field?.name,
      field?.idAttr,
      field?.ariaLabel
    ].filter(Boolean).join(" "));

    return FIELD_SEMANTICS.find((item) => item.keywords.some((keyword) => haystack.includes(normalizeText(keyword))))?.type || "";
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

        if (!isSamePersonScope(resumeField, formScope) || !isResumeFieldMatch(semantic, resumeField, field)) {
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

    if (/紧急联系|紧急联络|紧急电话|监护人/.test(source)) tags.push("contact");
    if (/父亲|爸爸/.test(source)) tags.push("father");
    if (/母亲|妈妈/.test(source)) tags.push("mother");
    if (/配偶|妻子|丈夫/.test(source)) tags.push("spouse");
    if (/家庭(?:主要)?成员|家属|亲属|兄弟|姐妹|子女/.test(source)) tags.push("relative");

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
      .filter(({ option }) => !(isObject(option) && option.disabled)
        && !/^(请选择|请输入|选择|please\s*(select|choose)|--|—)/i.test(optionText(option)));
    const findUsable = (test) => usable.find(({ option }) => test(option))?.index ?? -1;

    let index = findUsable((option) => optionValue(option) === target);
    if (index >= 0) return index;

    index = findUsable((option) => optionText(option) === target);
    if (index >= 0) return index;

    const normalizedTarget = normalizeText(target);
    if (!normalizedTarget) return -1;

    index = findUsable((option) => normalizeText(optionText(option)) === normalizedTarget);
    if (index >= 0) return index;

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

    // 「户口性质」「户籍类型」问的不是地方。
    if (/性质|类型|类别/.test(ownText)) {
      return false;
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

  function isResumeFieldMatch(semantic, resumeField, formField) {
    const keyText = normalizeText([resumeField?.group, resumeField?.key].filter(Boolean).join(" "));
    const value = String(resumeField?.value ?? "").trim();

    switch (semantic) {
      case "name":
        return keyText.includes("姓名") && !keyText.includes("拼音");
      case "email":
        return /@/.test(value) || keyText.includes("邮箱") || keyText.includes("email");
      case "phone":
        return /^(\+?\d[\d\s-]{7,})$/.test(value) || keyText.includes("手机") || keyText.includes("电话");
      case "gender":
        return /(男|女|male|female)/i.test(value) || keyText.includes("性别");
      case "birth_date":
        return /出生|生日|birth/.test(keyText) || /(\d{4}[-/.年]\d{1,2}([-/.\月]\d{1,2}日?)?)/.test(value);
      case "id_number":
        return keyText.includes("身份证") || keyText.includes("证件") || /^[0-9xX]{8,18}$/.test(value.replace(/\s/g, ""));
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

    if ((field?.inputType === "select" || field?.inputType === "radio") && Array.isArray(field?.options) && field.options.length && field?.cascadeGroup === undefined) {
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

    const separatorMatch = raw.match(/^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2})(?!\d))?(?:[T\s](\d{1,2}):(\d{1,2}))?/);
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
