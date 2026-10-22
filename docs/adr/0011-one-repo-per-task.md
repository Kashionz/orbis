# 一個 Task 只對應一個 Repo

一個 Project 可以有多個 Repo，但每個 Task（以及它的 Run、Worktree、PR）只對應一個 Repo。跨 Repo 的需求拆成多個 Task，再用 `depends_on` 串起來。跨 Repo 的單一 Task 需要協調多個 Worktree，還要讓多個 PR 一起合併，複雜度不成比例，所以 Phase 1 明確不做。
