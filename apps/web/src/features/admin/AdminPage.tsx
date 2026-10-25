import { useSuspenseQuery } from "@tanstack/react-query";
import { projectsQuery } from "../../api/resources";
import { useT } from "../../i18n";
import { usePermissions } from "../auth/use-permissions";
import { CredentialsSection, TeamRunnerQueueSection } from "./CredentialsSection";
import { MembersSection, ProjectRolesSection } from "./MembersSection";
import { PolicySection, RunnersSection } from "./RunnersSection";

/**
 * 管理頁（ARCHITECTURE §7、§12.2）：Credential 與 Team Runner 佇列 Member 以上都看得到；
 * 成員與 Role、Project 的 Role 覆寫、Runner 與 Pairing token、Permission Policy 與設定的信任核准
 * 只有 Admin 以上看得到。UI 只負責隱藏，權限以 Server 為準。
 */
export function AdminPage() {
  const t = useT();
  const permissions = usePermissions();
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const isAdmin = permissions.can("team.manage");
  // 管理的 Project：Team Role 是 Admin 以上時，Project 的有效 Role 一律是 Admin 以上
  const managed = projects.filter((p) => p.viewerRole === "owner" || p.viewerRole === "admin");

  if (!permissions.can("task.edit")) {
    return (
      <main className="notice">
        <h1>{t.admin.noPermissionTitle}</h1>
        <p>{t.admin.noPermissionBody(t.labels.role.member)}</p>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="page-header">
        <h1>{t.admin.title}</h1>
      </header>
      <CredentialsSection canOverride={isAdmin} />
      <TeamRunnerQueueSection />
      {isAdmin && (
        <>
          <MembersSection myRole={permissions.ctx.role} myMemberId={permissions.ctx.memberId} />
          {managed.length > 0 && <ProjectRolesSection projects={managed} />}
          <RunnersSection />
          <PolicySection projects={managed} />
        </>
      )}
    </main>
  );
}
