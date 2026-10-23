// @mention（ARCHITECTURE §12.3）：解析 Task 留言、Spec、diff 行內留言中的 @member 與 @agent。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubDomainService } from "../src/domain/github-domain";
import { createTestContext, seedProject, seedReadyTask, seedTeam } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

describe.skipIf(dbSkipReason !== null)("同步到 GitHub Issue 時的 mention", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("Member 換成 @login；Agent、別的 Team 的 Member 只留顯示名稱", async () => {
    const team = await seedTeam(database.db);
    const other = await seedTeam(database.db, "Other");
    const { project, repo } = await seedProject(database.db, team.teamId);
    const member = team.members.member;
    const task = await seedReadyTask(database.db, project, repo.id, {
      description: `請 @[小明](member:${member.id}) 看，@[claude](agent:claude-code) 與 @[外人](member:${other.members.owner.id})`,
    });
    const ctx = createTestContext(database.db);
    const domain = new GitHubDomainService(database.db, ctx.services.lifecycle);
    const record = await domain.getTask(task.id);
    expect(record?.description).toBe(`請 @user${member.githubUserId} 看，claude 與 外人`);
  });
});
