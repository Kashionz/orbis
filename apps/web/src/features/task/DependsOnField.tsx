import type { Task } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { tasksQuery } from "../../api/resources";
import { TASK_STATUS_LABELS } from "../../lib/labels";
import { matchesTaskKey, parseTaskKeyQuery } from "../../lib/task-key-search";

interface DependsOnFieldProps {
  task: Task;
  canEdit: boolean;
  onSave: (dependsOn: string[]) => void;
}

/** 這個 Task 依賴的其他 Task（同一個 Project），以 Task Key 搜尋加入。 */
export function DependsOnField({ task, canEdit, onSave }: DependsOnFieldProps) {
  const { data: tasks = [] } = useQuery(tasksQuery(task.projectId));
  const [search, setSearch] = useState("");
  const dependencies = task.dependsOn.map((id) => tasks.find((t) => t.id === id));
  const query = parseTaskKeyQuery(search);
  const candidates = query
    ? tasks.filter(
        (t) => t.id !== task.id && !task.dependsOn.includes(t.id) && matchesTaskKey(t.key, query),
      )
    : [];

  return (
    <dl>
      <dt>依賴（depends_on）</dt>
      <dd>
        {dependencies.length === 0 && <span className="empty">沒有</span>}
        <ul className="depends-list">
          {dependencies.map((dependency, index) => {
            const id = task.dependsOn[index] ?? "";
            return (
              <li key={id}>
                {dependency ? (
                  <>
                    <Link to="/tasks/$taskKey" params={{ taskKey: dependency.key }}>
                      {dependency.key}
                    </Link>{" "}
                    <span className="hint">{TASK_STATUS_LABELS[dependency.status]}</span>
                  </>
                ) : (
                  <span className="hint">{id}</span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`移除依賴 ${dependency?.key ?? id}`}
                    onClick={() => onSave(task.dependsOn.filter((d) => d !== id))}
                  >
                    移除
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && (
          <>
            <input
              type="search"
              aria-label="以 Task Key 加入依賴"
              placeholder="輸入 Task Key"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ul className="suggestions">
              {candidates.slice(0, 8).map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSave([...task.dependsOn, candidate.id]);
                      setSearch("");
                    }}
                  >
                    {candidate.key} {candidate.title}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </dd>
    </dl>
  );
}
