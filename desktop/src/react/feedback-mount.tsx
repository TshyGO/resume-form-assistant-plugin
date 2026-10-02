import type { Invoke } from "../api.ts";
import { mountReact } from "./mount.tsx";
import { FeedbackSettings } from "./FeedbackSettings.tsx";
export function mountFeedbackSettings(container: Element, consentContainer: Element, invoke: Invoke | null) {
  return mountReact(container, invoke, <FeedbackSettings invoke={invoke} consentContainer={consentContainer} />);
}
