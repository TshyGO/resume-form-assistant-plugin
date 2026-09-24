// 插件的 resume-utils.js / ai-helpers.js 是自包含 IIFE：没有 CommonJS 时把 API 挂到 globalThis。
// 与 profile.ts 同一做法：副作用导入一次，再给 TS 一个有类型的入口。
import "./resume-utils.js";
import "./ai-helpers.js";

export interface ParsedField {
  group: string;
  key: string;
  value: string;
}

interface PdfLib {
  getDocument(options: Record<string, unknown>): { promise: Promise<unknown> };
}

interface ParseHelpers {
  normalizeParsedFields(payload: unknown): ParsedField[];
  extractPdfText(pdfjsLib: PdfLib, data: ArrayBuffer | Uint8Array, options?: Record<string, unknown>): Promise<string>;
  getPdfExtractionErrorMessage(error: unknown): string;
}

const g = globalThis as unknown as {
  ResumeProAIHelpers: { normalizeParsedFields: ParseHelpers["normalizeParsedFields"] };
  ResumeProUtils: { extractPdfText: ParseHelpers["extractPdfText"]; getPdfExtractionErrorMessage: ParseHelpers["getPdfExtractionErrorMessage"] };
};

export const parseHelpers: ParseHelpers = {
  normalizeParsedFields: (payload) => g.ResumeProAIHelpers.normalizeParsedFields(payload),
  extractPdfText: (lib, data, options) => g.ResumeProUtils.extractPdfText(lib, data, options),
  getPdfExtractionErrorMessage: (error) => g.ResumeProUtils.getPdfExtractionErrorMessage(error),
};

// 与插件 ai-worker.js handleParseResume 的 SYSTEM_PROMPT 逐行一致（测试锁死）。
export const RESUME_PARSE_SYSTEM_PROMPT = [
  "你是一个简历信息提取助手。请从用户提供的简历中提取所有关键信息。",
  "输出要求：",
  "1. 仅返回 JSON 数组，不含任何解释文字或 markdown 代码块",
  '2. 格式：[{"group":"分组名","key":"字段名","value":"字段值"}]',
  "3. 分组参考：基本信息、教育背景、实习经历、科研经历、校园经历、论文、专利、技能、证书、奖励",
  '4. 论文每条单独成行，字段名用"论文1标题"、"论文1期刊"、"论文1发表年份"等',
  '5. 专利每条单独成行，字段名用"专利1标题"、"专利1摘要"、"专利1申请号"等',
  '6. 多段经历用"实习1公司"、"实习2公司"等区分',
  "7. 字段值保持原文，不要缩写",
].join("\n");

export const RESUME_PARSE_USER_PREFIX = "请提取以下简历中的所有信息：\n\n";
