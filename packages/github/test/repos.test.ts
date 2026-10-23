// Repo 登記（App 安裝檢查、default branch）與 installation webhook。

import { describe, expect, it } from "vitest";
import { createWorld, fixture, PROJECT_ID, REPO_ID } from "./helpers/world";

describe("Repo 登記", () => {
  it("App 已安裝：回傳 installation、repo id 與 default branch（大小寫以 GitHub 為準）", async () => {
    const w = createWorld();
    w.repo.defaultBranch = "develop";
    const result = await w.integration.inspectRepo(
      w.repo.owner.toLowerCase(),
      w.repo.name.toUpperCase(),
      w.bob.id,
    );
    expect(result).toEqual({
      installed: true,
      installationId: w.repo.installationId,
      githubRepoId: w.repo.id,
      owner: w.repo.owner,
      name: w.repo.name,
      defaultBranch: "develop",
      htmlUrl: w.repo.htmlUrl,
    });
  });

  it("App 沒有安裝或 repo 不存在：回傳安裝連結", async () => {
    const w = createWorld();
    w.github.addRepo({
      id: 77,
      owner: "acme",
      name: "private",
      defaultBranch: "main",
      installationId: null,
    });
    const expected = {
      installed: false,
      installUrl: "https://github.com/apps/acme-pm/installations/new",
    };
    expect(await w.integration.inspectRepo("acme", "private", w.bob.id)).toEqual(expected);
    expect(await w.integration.inspectRepo("acme", "missing", w.bob.id)).toEqual(expected);
  });

  it("提出請求的 Member 本人對 repo 沒有寫入權限：回應與沒有安裝相同（不透露別的 Team 的 repo）", async () => {
    const w = createWorld();
    for (const role of ["none", "read", "triage"] as const) {
      w.github.roles.set(w.alice.githubLogin, role);
      expect(await w.integration.inspectRepo(w.repo.owner, w.repo.name, w.alice.id), role).toEqual({
        installed: false,
        installUrl: "https://github.com/apps/acme-pm/installations/new",
      });
    }
    expect(
      w.github.callsTo("getCollaboratorRole").map((c) => (c.args[2] as { login: string }).login),
    ).toEqual(["Codertocat", "Codertocat", "Codertocat"]);
    expect(
      await w.integration.inspectRepo(w.repo.owner, w.repo.name, "no-such-member"),
    ).toMatchObject({
      installed: false,
    });
  });

  it("Member 的 login 已經屬於另一個 GitHub 帳號（改名後被別人註冊）時不算有權限", async () => {
    const w = createWorld();
    // 現在叫 Codertocat 的是另一個帳號（id 不同），而且對 repo 有寫入權限
    w.github.addUser({ id: 5555, login: w.alice.githubLogin, type: "User" });
    expect(await w.integration.inspectRepo(w.repo.owner, w.repo.name, w.alice.id)).toMatchObject({
      installed: false,
    });
  });

  it("Team Runner push 用的 installation token 只限這個 repo", async () => {
    const w = createWorld();
    const token = await w.integration.getInstallationTokenForRepo(REPO_ID);
    expect(token.token).toBe(`ghs_scoped_${w.repo.installationId}_${w.repo.id}`);
    // 每次另外簽發、只限這個 repo 與 contents 寫入權限，不經過 Server 的快取
    expect(w.github.callsTo("createInstallationToken").map((c) => c.args)).toEqual([
      [w.repo.installationId, { repositoryIds: [w.repo.id], permissions: { contents: "write" } }],
    ]);
    expect(w.github.callsTo("installationToken")).toEqual([]);
    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    await expect(w.integration.getInstallationTokenForRepo(REPO_ID)).rejects.toThrow("沒有安裝");
  });
});

describe("installation webhook", () => {
  it("deleted：清掉 Repo 的 installation 與 token 快取", async () => {
    const w = createWorld();
    const payload = fixture("installation.deleted");
    payload.installation.id = w.repo.installationId;
    const response = await w.deliver("installation", payload);
    expect(response.body).toMatchObject({ result: { updatedRepoIds: [REPO_ID] } });
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBeNull();
    expect(w.github.forgotten).toEqual([w.repo.installationId]);
  });

  it("suspend：同 deleted", async () => {
    const w = createWorld();
    const payload = fixture("installation.suspend");
    payload.installation.id = w.repo.installationId;
    await w.deliver("installation", payload);
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBeNull();
  });

  it("created：payload 列出的 repo 補上 installation", async () => {
    const w = createWorld();
    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    const payload = fixture("installation.created");
    payload.installation.id = 555;
    payload.repositories = [
      { ...payload.repositories[0], id: w.repo.id, full_name: `${w.repo.owner}/${w.repo.name}` },
    ];
    await w.deliver("installation", payload);
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBe(555);
  });

  it("unsuspend：payload 沒有列出 repo 時，向 GitHub 查詢 installation 能存取的 repo", async () => {
    const w = createWorld();
    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    const payload = fixture("installation.unsuspend");
    expect(payload.repositories ?? []).toEqual([]);
    payload.installation.id = w.repo.installationId;
    await w.deliver("installation", payload);
    expect(w.github.callsTo("listInstallationRepositories")).toHaveLength(1);
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBe(w.repo.installationId);
  });

  describe("App 安裝之前登記、還不知道 repo id 的 Repo", () => {
    /** 在 Project 中登記一個尚未安裝 App 的 repo（只有名稱），之後 GitHub 上安裝 App。 */
    function unboundRepo() {
      const w = createWorld();
      const github = w.github.addRepo({
        id: 4242,
        owner: "Acme",
        name: "Later",
        defaultBranch: "trunk",
        installationId: 9_000,
      });
      w.domain.addRepo({
        id: "repo-later",
        projectId: PROJECT_ID,
        owner: "acme",
        name: "later",
        githubRepoId: null,
        defaultBranch: null,
        installationId: null,
      });
      const added = fixture("installation_repositories.added");
      added.installation.id = 9_000;
      added.repositories_added = [{ id: github.id, full_name: "Acme/Later" }];
      return { w, added };
    }

    it("安裝 App 的人是 Project Member 且有寫入權限：以名稱綁定，補上 repo id 與 default branch", async () => {
      const { w, added } = unboundRepo();
      added.sender = { ...added.sender, ...w.userRef(w.alice) };
      await w.deliver("installation_repositories", added);
      expect(w.domain.repos.get("repo-later")).toMatchObject({
        installationId: 9_000,
        githubRepoId: 4242,
        defaultBranch: "trunk",
      });
    });

    it("安裝 App 的人不是 Project Member：不綁定（避免別的 Team 先登記同名 repo）", async () => {
      const { w, added } = unboundRepo();
      w.github.roles.set(w.outsider.login, "admin");
      added.sender = { ...added.sender, ...w.outsider };
      await w.deliver("installation_repositories", added);
      expect(w.domain.repos.get("repo-later")).toMatchObject({
        installationId: null,
        githubRepoId: null,
      });
    });

    it("安裝 App 的人是 Member 但對 repo 沒有寫入權限：不綁定", async () => {
      const { w, added } = unboundRepo();
      w.github.roles.delete(w.alice.githubLogin);
      added.sender = { ...added.sender, ...w.userRef(w.alice) };
      await w.deliver("installation_repositories", added);
      expect(w.domain.repos.get("repo-later")?.installationId).toBeNull();
    });
  });

  it("installation_repositories：新增與移除 repo", async () => {
    const w = createWorld();
    const removed = fixture("installation_repositories.removed");
    removed.installation.id = w.repo.installationId;
    removed.repositories_removed = [{ ...removed.repositories_removed[0], id: w.repo.id }];
    await w.deliver("installation_repositories", removed);
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBeNull();

    const added = fixture("installation_repositories.added");
    added.installation.id = 777;
    added.repositories_added = [{ ...added.repositories_added[0], id: w.repo.id }];
    await w.deliver("installation_repositories", added);
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBe(777);
  });

  it("從另一個 installation 移除 repo 時，不清掉目前的 installation", async () => {
    const w = createWorld();
    const removed = fixture("installation_repositories.removed");
    removed.installation.id = 123_456;
    removed.repositories_removed = [{ ...removed.repositories_removed[0], id: w.repo.id }];
    await w.deliver("installation_repositories", removed);
    expect(w.domain.repos.get(REPO_ID)?.installationId).toBe(w.repo.installationId);
  });

  it("錄製的 payload 原樣送進來都能解析處理", async () => {
    const w = createWorld();
    for (const name of [
      "installation.created",
      "installation.unsuspend",
      "installation_repositories.added",
      "installation_repositories.removed",
    ]) {
      const response = await w.deliver(name.split(".")[0] ?? "", fixture(name));
      expect(response.status, name).toBe(200);
    }
  });
});
