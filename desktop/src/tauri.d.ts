// 宿主注入的全局对象（`withGlobalTauri`）。只声明这个前端真正用到的三样东西：
// 调命令、打开文件对话框、监听窗口事件。声明得窄一点，用错的时候类型会先说话。

import type { Invoke } from "./api.ts";

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke?: Invoke };
      dialog?: {
        open?: (options: {
          multiple?: boolean;
          directory?: boolean;
          filters?: Array<{ name: string; extensions: string[] }>;
        }) => Promise<string | string[] | null>;
      };
      event?: {
        listen?: (
          event: string,
          handler: (event: { payload?: { paths?: string[] } }) => void,
        ) => Promise<() => void>;
      };
    };
  }
}

export {};
