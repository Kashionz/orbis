import type { Project } from "@orbis/api-contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createProject, queryKeys } from "../../api/resources";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { useT } from "../../i18n";
import { type ProjectFormValues, validateProjectForm } from "../../lib/project-forms";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 建立 Project（Team Role 是 Admin 以上），建立後切換到它的看板。 */
export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const t = useT();
  return (
    <Dialog title={t.project.createProject} open={open} onClose={onClose}>
      {open && <CreateProjectForm onClose={onClose} />}
    </Dialog>
  );
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const t = useT();
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
      <TextField
        label={t.project.name}
        value={values.name}
        onChange={set("name")}
        error={errors.name}
      />
      <TextField
        label={t.project.keyPrefix}
        value={values.keyPrefix}
        onChange={set("keyPrefix")}
        error={errors.keyPrefix}
        hint={t.project.keyPrefixHint}
        maxLength={10}
      />
      <TextField
        label={t.project.description}
        value={values.description}
        onChange={set("description")}
        multiline
      />
      <ErrorText error={mutation.error} />
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {t.common.create}
        </Button>
      </div>
    </form>
  );
}
