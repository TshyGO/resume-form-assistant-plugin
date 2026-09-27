import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureReadableStreamAsyncIterator } from "./readable-stream-iterator.ts";

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

test("取消迟迟不结束时也先释放锁，再等取消结果（与规范 return() 一致）", async () => {
  const Stream = webkitLikeStreamClass();
  ensureReadableStreamAsyncIterator(Stream.prototype);
  let finishCancel = () => {};
  const stream = new Stream<number>({
    pull(controller) {
      controller.enqueue(1);
    },
    cancel() {
      return new Promise<void>((resolve) => {
        finishCancel = resolve;
      });
    },
  });
  const iterator = (stream as unknown as AsyncIterable<number>)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  let returned = false;
  const returning = iterator.return!().then((result) => {
    returned = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stream.locked, false);
  assert.equal(returned, false);
  finishCancel();
  assert.deepEqual(await returning, { done: true, value: undefined });
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
