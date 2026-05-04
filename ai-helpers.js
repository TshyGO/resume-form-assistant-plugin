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
    { type: "hometown", keywords: ["籍贯", "生源地", "nativeplace", "hometown"] },
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
    shouldSkipAIForField,
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

  function buildRuleBasedMatches(formFields, resumeFields) {
    const strongTypes = new Set(["name", "email", "phone", "gender", "birth_date", "id_number", "hometown", "region"]);
    const matches = [];
    const usedResumeIndexes = new Set();

    formFields.forEach((field) => {
      const semantic = inferFieldSemantic(field);

      if (!strongTypes.has(semantic)) {
        return;
      }

      const matchIndex = resumeFields.findIndex((resumeField, index) => {
        if (usedResumeIndexes.has(index)) {
          return false;
        }

        return isResumeFieldMatch(semantic, resumeField);
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

  function shouldSkipAIForField(field) {
    const semantic = inferFieldSemantic(field);

    if (["name", "email", "phone", "gender", "birth_date", "id_number", "hometown", "region", "pinyin"].includes(semantic)) {
      return true;
    }

    if ((field?.inputType === "select" || field?.inputType === "radio") && Array.isArray(field?.options) && field.options.length) {
      const text = normalizeText([
        field?.label,
        field?.placeholder,
        field?.name,
        field?.ariaLabel
      ].filter(Boolean).join(" "));

      if (/证件类型|外语类型|外语等级|年份|年月|月份|学位|学历|培养层次/.test(text)) {
        return true;
      }
    }

    return false;
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

  function isResumeFieldMatch(semantic, resumeField) {
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
        return keyText.includes("籍贯") || keyText.includes("生源地");
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
      const normalizedValue = normalizeText(text);
      const hasOption = field.options.some((option) => normalizeText(option) === normalizedValue);

      if (!hasOption) {
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
