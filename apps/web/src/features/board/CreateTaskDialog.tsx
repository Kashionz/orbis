import type { Project } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createTask, queryKeys, reposQuery } from "../../api/resources";
import { Dialog } from "../../components/Dialog";
import { ErrorText } from "../../components/ErrorText";

interface CreateTaskDialogProps {
  project: Project;
  open: boolean;
  onClose: () => void;
}

/** 在 Project 中建立 Task（從 Backlog 開始），建立後開啟 Task 頁。 */
export function CreateTaskDialog({ project, open, onClose }: CreateTaskDialogProps) {
  return (
    <Dialog title="新增 Task" open={open} onClose={onClose}>
      {open && <CreateTaskForm project={project} onClose={onClose} />}
    </Dialog>
  );
}

function CreateTaskForm({ project, onClose }: Omit<CreateTaskDialogProps, "open">) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: repos = [], isSuccess: reposLoaded } = useQuery(reposQuery(project.id));
  const [title, setTitle] = useState("");
  const [repoId, setRepoId] = useState("");
  const [description, setDescription] = useState("");
  const selectedRepo = repoId || repos[0]?.id || "";

  const mutation = useMutation({
    mutationFn: () =>
      createTask(project.id, { repoId: selectedRepo, title: title.trim(), description }),
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(project.id) });
      onClose();
      await navigate({ to: "/tasks/$taskKey", params: { taskKey: task.key } });
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label className="field">
        標題
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
        />
      </label>
      <label className="field">
        Repo
        <select value={selectedRepo} onChange={(event) => setRepoId(event.target.value)}>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.owner}/{repo.name}
            </option>
          ))}
        </select>
      </label>
      {reposLoaded && repos.length === 0 && (
        <p className="warning">
          這個 Project 還沒有登記 Repo，請先到{" "}
          <Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
            Project 設定
          </Link>
          登記。
        </p>
      )}
      <label className="field">
        描述（markdown）
        <textarea
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <ErrorText error={mutation.error} />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="submit"
          className="primary"
          disabled={title.trim() === "" || selectedRepo === "" || mutation.isPending}
        >
          建立
        </button>
      </div>
    </form>
  );
}
