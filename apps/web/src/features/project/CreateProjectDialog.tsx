import type { Project } from "@orbis/api-contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createProject, queryKeys } from "../../api/resources";
import { Dialog } from "../../components/Dialog";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { type ProjectFormValues, validateProjectForm } from "../../lib/project-forms";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 建立 Project（Team Role 是 Admin 以上），建立後切換到它的看板。 */
export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  return (
    <Dialog title="新增 Project" open={open} onClose={onClose}>
      {open && <CreateProjectForm onClose={onClose} />}
    </Dialog>
  );
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ProjectFormValues>({
    name: "",
    keyPrefix: "",
    description: "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ProjectFormValues, string>>>({});
  const set = (field: keyof ProjectFormValues) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: async (project) => {
      queryClient.setQueryData<Project[]>(queryKeys.projects, (list) => list && [...list, project]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects, exact: true });
      onClose();
      await navigate({ to: "/board", search: { project: project.id } });
    },
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateProjectForm(values);
        setErrors(result.ok ? {} : result.errors);
        if (result.ok) mutation.mutate(result.input);
      }}
    >
      <TextField label="名稱" value={values.name} onChange={set("name")} error={errors.name} />
      <TextField
        label="Task Key 前綴"
        value={values.keyPrefix}
        onChange={set("keyPrefix")}
        error={errors.keyPrefix}
        hint="例如 ORB，Task Key 會是 ORB-1、ORB-2…。2–10 個大寫英文字母或數字，以字母開頭，建立後不能修改。"
        maxLength={10}
      />
      <TextField label="描述" value={values.description} onChange={set("description")} multiline />
      <ErrorText error={mutation.error} />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="primary" disabled={mutation.isPending}>
          建立
        </button>
      </div>
    </form>
  );
}
