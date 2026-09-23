export interface ModelTransportResult {
  ok: boolean;
  reason?: string;
  message?: string;
  models?: string[];
  hiddenCount?: number;
  allModels?: string[];
}

declare global {
  var ResumeProModels: {
    interpretModelTransport(raw: {
      reason?: string;
      status?: number | null;
      body?: string;
      timeoutMs?: number;
    }): ModelTransportResult;
  };
}

export {};
