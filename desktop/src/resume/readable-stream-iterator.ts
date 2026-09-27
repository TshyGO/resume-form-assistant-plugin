/**
 * pdf.js 6.x 的 page.getTextContent() 内部写的是 `for await (const value of readableStream)`，
 * 要求 ReadableStream 可异步迭代。Chromium（旧插件、Windows 的 WebView2）有，
 * macOS 的 WKWebView（Linux 的 WebKitGTK 同为 WebKit）没有，legacy 构建也不补——
 * 于是 Mac 桌面端所有 PDF 都在这里抛 `TypeError: undefined is not a function`，
 * 界面落到「PDF 解析失败，请确认文件可以正常打开」，像是用户的文件坏了。
 *
 * 缺了才补，行为按规范的 values()（preventCancel 为 false）：读完释放锁；
 * 提前 break 或出错时先取消流再释放锁。
 */
export function ensureReadableStreamAsyncIterator(proto: ReadableStream = ReadableStream.prototype): void {
  const target = proto as unknown as Record<symbol, unknown>;
  if (typeof target[Symbol.asyncIterator] === "function") return;
  Object.defineProperty(target, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* <T>(this: ReadableStream<T>): AsyncGenerator<T, void, undefined> {
      const reader = this.getReader();
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            return;
          }
          yield value;
        }
      } finally {
        if (!finished) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  });
}
