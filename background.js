importScripts("ai-helpers.js", "resume-utils.js");

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

const activeFillRequests = new Map();

function fillRequestKey(message, sender) {
  return JSON.stringify([sender.tab?.id, sender.frameId, sender.documentId, message.requestId]);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CANCEL_AI_FILL") {
    const controller = activeFillRequests.get(fillRequestKey(message, sender));
    controller?.abort();
    sendResponse({ cancelled: Boolean(controller) });
    return false;
  }
  if (message?.type === "AI_FILL") {
    const key = fillRequestKey(message, sender);
    if (activeFillRequests.has(key)) {
      sendResponse({ success: false, error: "该填写请求仍在处理中。" });
      return false;
    }
    const controller = new AbortController();
    activeFillRequests.set(key, controller);
    handleAiFill(message, controller)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ success: false, error: error.message || "AI 请求失败。" });
      })
      .finally(() => activeFillRequests.delete(key));
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

async function handleAiFill(message, controller = new AbortController()) {
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
  const candidates = ResumeProAIHelpers.selectResumeCandidates(remainingFormFields, resumeFields);
  const diagnostics = {
    ruleMatches: ruleMatches.length, aiFields: remainingFormFields.length,
    candidateFields: remainingFormFields.length ? candidates.length : 0,
    resumeFields: resumeFields.length, apiMs: 0, promptBytes: 0,
    errorCode: "none", aiMatches: 0
  };
  let warning = "";

  if (remainingFormFields.length) {
    const apiStart = performance.now();
    try {
      const prompt = buildUserPrompt(remainingFormFields, candidates);
      diagnostics.promptBytes = new TextEncoder().encode(prompt).length;
      const response = await fetch(aiConfig.apiUrl, {
        signal: controller.signal,
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
            { role: "user", content: prompt }
          ]
        })
      });

      if (!response.ok) {
        diagnostics.errorCode = `http_${response.status}`;
        controller.abort();
        throw new Error(`AI 接口请求失败：HTTP ${response.status}。请检查接口配置或稍后重试。`);
      }
      const data = await response.json();
      // Ignore a response if cancellation raced with its completion.
      if (controller.signal.aborted) throw new Error("cancelled");

      const content = data?.choices?.[0]?.message?.content;

      if (typeof content !== "string" || !content.trim()) {
        diagnostics.errorCode = "format";
        throw new Error("AI 未返回可解析的内容。");
      }

      try {
        aiMatches = ResumeProAIHelpers.filterValidMatches(remainingFormFields, normalizeMatches(parseJsonContent(content)));
        diagnostics.aiMatches = aiMatches.length;
      } catch (error) {
        diagnostics.errorCode = "format";
        throw new Error("AI 返回格式异常，无法解析。");
      }
    } catch (error) {
      if (diagnostics.errorCode !== "none") {
        warning = error.message;
      } else if (controller.signal.aborted) {
        diagnostics.errorCode = "cancelled";
        warning = "已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。";
      } else if (error instanceof SyntaxError) {
        diagnostics.errorCode = "format";
        warning = "AI 返回格式异常，无法解析。";
      } else {
        diagnostics.errorCode = "network";
        warning = "AI 网络请求失败，请检查网络或接口地址。";
      }
    } finally {
      diagnostics.apiMs = performance.now() - apiStart;
    }
  }

  const matches = ResumeProAIHelpers.filterValidMatches(formFields, [...ruleMatches, ...aiMatches]);
  return { success: !warning || matches.length > 0, matches, warning,
    error: warning, diagnostics };
}

async function handleParseResume(message) {
  const { content } = message;
  const aiConfig = normalizeAiConfig(message.aiConfig);

  if (!aiConfig.apiUrl || !aiConfig.model || !aiConfig.apiKey) {
    return { success: false, error: "请先配置 AI 接口。" };
  }

  const resumeText = String(content ?? "").trim();
  if (!resumeText) {
    return { success: false, error: "简历中没有可发送给 AI 的文字。" };
  }

  const userContent = `请提取以下简历中的所有信息：\n\n${resumeText}`;

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

  let response;

  try {
    response = await fetch(aiConfig.apiUrl, {
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
  } catch {
    return { success: false, error: "无法连接 AI 接口，请检查网络和 API URL。" };
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
    return { success: false, error: ResumeProUtils.formatAiError(response.status, detail) };
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
    JSON.stringify(formFields),
    "",
    "简历字段列表：",
    JSON.stringify(resumeFields),
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
