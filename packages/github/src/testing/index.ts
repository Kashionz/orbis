// 測試用的 fake 與 GitHubStore 契約測試（`@orbis/github/testing`）。

export { TestClock } from "./clock";
export {
  type DomainClock,
  FakeDomainService,
  MemoryLogger,
  type RecordedNotification,
  type RecordedTransition,
  RecordingNotifier,
} from "./fake-domain";
export { type FakeCall, type FakeComment, FakeGitHub, type FakeRepo } from "./fake-github";
export { InMemoryGitHubStore } from "./memory-store";
