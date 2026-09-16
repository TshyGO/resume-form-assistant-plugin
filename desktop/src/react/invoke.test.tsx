import { expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import type { Invoke } from "../api.ts";
import { InvokeProvider, useInvoke } from "./invoke.tsx";

function Probe() {
  const invoke = useInvoke();
  const [text, setText] = useState("等待中");
  useEffect(() => {
    if (!invoke) {
      setText("没连上桌面宿主");
      return;
    }
    invoke<string>("get_runtime_status")
      .then((value) => setText(value))
      .catch((err: { code?: string }) => setText(`失败：${err.code ?? "UNKNOWN"}`));
  }, [invoke]);
  return <p>{text}</p>;
}

test("组件经 context 调命令", async () => {
  render(
    <InvokeProvider invoke={(async () => "已连接") as Invoke}>
      <Probe />
    </InvokeProvider>,
  );
  await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
});

test("命令报错时把错误码显示出来", async () => {
  render(
    <InvokeProvider invoke={(async () => Promise.reject({ code: "STORE_UNAVAILABLE", message: "档案没打开" })) as Invoke}>
      <Probe />
    </InvokeProvider>,
  );
  await waitFor(() => expect(screen.getByText("失败：STORE_UNAVAILABLE")).toBeTruthy());
});

test("没有宿主时如实显示，不崩", async () => {
  render(
    <InvokeProvider invoke={null}>
      <Probe />
    </InvokeProvider>,
  );
  await waitFor(() => expect(screen.getByText("没连上桌面宿主")).toBeTruthy());
});
