# 一個 Task 只對應一個 Repo

一個 Project 可以有多個 Repo，但每個 Task（以及它的 Run、Worktree、PR）只對應一個 Repo。跨 Repo 的需求拆成多個 Task，再用 `depends_on` 串起來。跨 Repo 的單一 Task 需要協調多個 Worktree，還要讓多個 PR 一起合併，複雜度不成比例，所以 Phase 1 明確不做。

## 修訂：不指定 Repo 的 Task（2026-10-25）

想法剛出現時常常還不知道要改哪個 Repo，所以建立 Task 時可以不指定 Repo。這種 Task 只能停在 Backlog：不能移到 Ready、不能派工、不同步到 GitHub Issues。之後可以補指定一次（從沒有到某個 Repo），指定之後就不能再換，所以「一個 Task 只對應一個 Repo」仍然成立。補指定後才開始同步 Issues。

- 更換已指定的 Repo 回 409 `repo_already_set`；沒有 Repo 時移到 Ready 回 409 `repo_required`。
- 「建立後不能更換」原本只靠 `UpdateTaskInput` 沒有 `repoId` 欄位；現在 `UpdateTaskInput` 有 `repoId`，由 Server 檢查只接受從沒有到有。
