import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureReadableStreamAsyncIterator } from "./readable-stream-iterator.ts";
import { parseHelpers } from "./parse-helpers.ts";

// macOS 的 WKWebView（Linux 的 WebKitGTK 同理）没有 ReadableStream[Symbol.asyncIterator]，
// Node 有。这里给 ReadableStream 派生一个子类，在子类原型上把它遮成 undefined，
// 模拟 WebKit 的样子，又不碰全局的 ReadableStream。
function webkitLikeStreamClass() {
  class WebKitLikeStream<T> extends ReadableStream<T> {}
  Object.defineProperty(WebKitLikeStream.prototype, Symbol.asyncIterator, {
    value: undefined,
    writable: true,
    configurable: true,
  });
  return WebKitLikeStream;
}

function streamOf<T>(Stream: new (source: UnderlyingDefaultSource<T>) => ReadableStream<T>, chunks: T[]) {
  return new Stream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<T>) out.push(chunk);
  return out;
}

test("缺 asyncIterator 时补上：for await 按顺序读完，读完后释放锁", async () => {
  const Stream = webkitLikeStreamClass();
  await assert.rejects(collect(streamOf(Stream, [1])), TypeError);

  ensureReadableStreamAsyncIterator(Stream.prototype);
  const stream = streamOf(Stream, [1, 2, 3]);
  assert.deepEqual(await collect(stream), [1, 2, 3]);
  assert.equal(stream.locked, false);
});

test("提前 break 时取消流并释放锁，与原生行为一致", async () => {
  const Stream = webkitLikeStreamClass();
  ensureReadableStreamAsyncIterator(Stream.prototype);
  let cancelled = false;
  const stream = new Stream<number>({
    pull(controller) {
      controller.enqueue(1);
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const chunk of stream as unknown as AsyncIterable<number>) {
    assert.equal(chunk, 1);
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("流出错时把错误抛给 for await，并释放锁", async () => {
  const Stream = webkitLikeStreamClass();
  ensureReadableStreamAsyncIterator(Stream.prototype);
  const stream = new Stream<number>({
    start(controller) {
      controller.error(new Error("boom"));
    },
  });
  await assert.rejects(collect(stream), /boom/);
  assert.equal(stream.locked, false);
});

test("已有原生实现时不覆盖", () => {
  const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
  const native = proto[Symbol.asyncIterator];
  ensureReadableStreamAsyncIterator(ReadableStream.prototype);
  assert.equal(proto[Symbol.asyncIterator], native);
});

// 真实复现：pdf.js 6.x 的 page.getTextContent() 内部是 `for await (const v of readableStream)`。
// 最小 PDF：一页、Helvetica、一行文字（xref 偏移不精确，pdf.js 会自行重建）。
const MINIMAL_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 20 100 Td (Resume Pro) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;

test("真实 pdf.js：WebKit 缺 asyncIterator 时 getTextContent 失败，补上后能抽出文字", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
  const native = Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator)!;
  const pdfBytes = () => new TextEncoder().encode(MINIMAL_PDF);
  try {
    delete proto[Symbol.asyncIterator];
    await assert.rejects(parseHelpers.extractPdfText(pdfjs as never, pdfBytes(), { verbosity: 0 }), TypeError);

    ensureReadableStreamAsyncIterator(ReadableStream.prototype);
    assert.equal(await parseHelpers.extractPdfText(pdfjs as never, pdfBytes(), { verbosity: 0 }), "Resume Pro");
  } finally {
    Object.defineProperty(proto, Symbol.asyncIterator, native);
  }
});
