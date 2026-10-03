import { Component } from "react";
import type { ReactNode } from "react";
import type { Invoke } from "../api.ts";
import { reportFrontendError } from "../feedback.ts";

export class ErrorBoundary extends Component<{ children: ReactNode; invoke: Invoke | null }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { reportFrontendError(error, this.props.invoke); }
  override render() {
    if (this.state.failed) return <div role="alert" className="note warn"><p>这部分界面暂时无法显示，请尝试重新显示。</p><button type="button" onClick={() => this.setState({ failed: false })}>重新显示</button></div>;
    return this.props.children;
  }
}
