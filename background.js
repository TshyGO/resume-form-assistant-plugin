importScripts("ai-helpers.js");

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_MANAGER" });
    } catch {
      // content script not injected on this page (e.g. chrome:// pages)
    }
  }
});

const AI_SYSTEM_PROMPT = [
  "你是一个网页表单填写助手。根据简历字段数据，判断表单中每个输入框应该填写什么值。",
  "规则：",
  "1. 仅返回 JSON 数组，不含任何解释或 markdown 代码块",
  '2. 格式：[{"fieldId":"xxx","value":"yyy"}]',
  "3. 只填写能确定匹配的字段，不确定的跳过",
  "4. 基本信息字段优先精确匹配，不要把教育背景、经历、技能字段填进姓名、邮箱、手机号、出生日期等基础字段",
  "5. 遇到拼音、证件类型、外语类型/等级、年月分拆下拉框等复杂字段，只有在能确定时才填写",
  "6. 匹配考虑同义词：手机=电话=联系方式=mobile=phone"
].join("\n");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AI_FILL") {
    handleAiFill(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ success: false, error: error.message || "AI 请求失败。" });
      });
    return true;
  }

  if (message?.type === "PARSE_RESUME") {
    handleParseResume(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ success: false, error: error.message || "简历解析失败。" });
      });
    return true;
  }

  return false;
});

async function handleAiFill(message) {
  const aiConfig = normalizeAiConfig(message.aiConfig);
  const formFields = Array.isArray(message.formFields) ? message.formFields : [];
  const resumeFields = Array.isArray(message.resumeFields) ? message.resumeFields : [];

  if (!aiConfig.apiUrl || !aiConfig.model || !aiConfig.apiKey) {
    return { success: false, error: "请先在插件中配置 AI 接口。" };
  }

  if (!formFields.length) {
    return { success: false, error: "当前页面没有可填写的表单字段。" };
  }

  if (!resumeFields.length) {
    return { success: false, error: "当前模板没有可用字段。" };
  }

  const ruleMatches = ResumeProAIHelpers.buildRuleBasedMatches(formFields, resumeFields);
  const matchedFieldIds = new Set(ruleMatches.map((match) => match.fieldId));
  const remainingFormFields = formFields.filter((field) => {
    if (matchedFieldIds.has(field.fieldId)) {
      return false;
    }

    return !ResumeProAIHelpers.shouldSkipAIForField(field);
  });
  let aiMatches = [];

  if (remainingFormFields.length) {
    const response = await fetch(aiConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: aiConfig.model,
        temperature: 0,
        messages: [
          { role: "system", content: AI_SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(remainingFormFields, resumeFields) }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
      return { success: false, error: `AI 接口请求失败：${detail}` };
    }

    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      return { success: false, error: "AI 未返回可解析的内容。" };
    }

    try {
      aiMatches = normalizeMatches(parseJsonContent(content));
    } catch (error) {
      return { success: false, error: `AI 返回结果解析失败：${error.message}` };
    }
  }

  const matches = ResumeProAIHelpers.filterValidMatches(formFields, [...ruleMatches, ...aiMatches]);
  return { success: true, matches };
}

async function handleParseResume(message) {
  const { fileType, content } = message;
  const aiConfig = normalizeAiConfig(message.aiConfig);

  if (!aiConfig.apiUrl || !aiConfig.model || !aiConfig.apiKey) {
    return { success: false, error: "请先配置 AI 接口。" };
  }

  let userContent;

  if (fileType === "pdf") {
    userContent = [
      { type: "text", text: "请提取以下 PDF 简历中的所有信息：" },
      { type: "image_url", image_url: { url: content } }
    ];
  } else {
    userContent = `请提取以下简历中的所有信息：\n\n${String(content ?? "")}`;
  }

  const SYSTEM_PROMPT = [
    "你是一个简历信息提取助手。请从用户提供的简历中提取所有关键信息。",
    "输出要求：",
    "1. 仅返回 JSON 数组，不含任何解释文字或 markdown 代码块",
    '2. 格式：[{"group":"分组名","key":"字段名","value":"字段值"}]',
    "3. 分组参考：基本信息、教育背景、实习经历、科研经历、校园经历、论文、专利、技能、证书、奖励",
    '4. 论文每条单独成行，字段名用"论文1标题"、"论文1期刊"、"论文1发表年份"等',
    '5. 专利每条单独成行，字段名用"专利1标题"、"专利1摘要"、"专利1申请号"等',
    '6. 多段经历用"实习1公司"、"实习2公司"等区分',
    "7. 字段值保持原文，不要缩写"
  ].join("\n");

  const response = await fetch(aiConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent }
      ]
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.message || `HTTP ${response.status}`;

    if (fileType === "pdf" && response.status === 400) {
      return {
        success: false,
        error: "当前模型不支持 PDF，请改用 Word 或 TXT，或换用支持视觉的模型（如 gpt-4o）。"
      };
    }

    return { success: false, error: `AI 请求失败：${detail}` };
  }

  const rawContent = data?.choices?.[0]?.message?.content || "";

  try {
    const fields = normalizeParsedFields(parseJsonContent(rawContent));

    if (!fields.length) {
      return { success: false, error: "AI 未能提取到有效信息，请检查文件内容。" };
    }

    return { success: true, fields };
  } catch {
    return { success: false, error: "AI 返回格式异常，无法解析。" };
  }
}

function buildUserPrompt(formFields, resumeFields) {
  return [
    "表单字段列表：",
    JSON.stringify(formFields, null, 2),
    "",
    "简历字段列表：",
    JSON.stringify(resumeFields, null, 2),
    "",
    "填写原则：基本信息优先匹配基本信息分组；教育背景不要填进邮箱、电话、出生日期、籍贯等基础字段；低置信度时留空。"
  ].join("\n");
}

function parseJsonContent(content) {
  const cleaned = content
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

function normalizeMatches(payload) {
  const source = Array.isArray(payload) ? payload : payload?.matches;

  if (!Array.isArray(source)) {
    throw new Error("结果不是 JSON 数组。");
  }

  return source
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const fieldId = String(item.fieldId ?? "").trim();
      const value = String(item.value ?? "");

      if (!fieldId || !value) {
        return null;
      }

      return { fieldId, value };
    })
    .filter(Boolean);
}

function normalizeParsedFields(payload) {
  return ResumeProAIHelpers.normalizeParsedFields(payload);
}

function normalizeAiConfig(aiConfig) {
  return {
    apiUrl: String(aiConfig?.apiUrl ?? "").trim(),
    model: String(aiConfig?.model ?? "").trim(),
    apiKey: String(aiConfig?.apiKey ?? "").trim()
  };
}
