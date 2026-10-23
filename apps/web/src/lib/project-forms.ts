// 建立 Project 與登記 Repo 的表單驗證：規則取自契約的 schema，送出前先在表單上標出每個欄位的問題。
// Server 仍會再驗證一次，它回的 `issues` 由 ErrorText 顯示。

import {
  CreateProjectInput,
  type CreateProjectInput as CreateProjectRequest,
  CreateRepoInput,
  type CreateRepoInput as CreateRepoRequest,
} from "@orbis/api-contract";
import type { z } from "zod";

/** 驗證結果：通過時是要送出的輸入，否則是每個欄位的第一個問題。 */
export type FormResult<Input, Field extends string> =
  | { ok: true; input: Input }
  | { ok: false; errors: Partial<Record<Field, string>> };

function validate<Input, Field extends string>(
  schema: z.ZodType,
  input: Input,
): FormResult<Input, Field> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, input };
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "") as Field;
    errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}

export interface ProjectFormValues {
  name: string;
  keyPrefix: string;
  description: string;
}

/** 建立 Project 的表單。名稱前後的空白去掉，Task Key 前綴轉成大寫。 */
export function validateProjectForm(
  values: ProjectFormValues,
): FormResult<CreateProjectRequest, keyof ProjectFormValues> {
  return validate(CreateProjectInput, {
    name: values.name.trim(),
    keyPrefix: values.keyPrefix.trim().toUpperCase(),
    description: values.description,
  });
}

export interface RepoFormValues {
  owner: string;
  name: string;
  defaultBranch: string;
}

/** 登記 Repo 的表單。default branch 留空時不送，由 Server 依 GitHub App 的安裝狀態決定。 */
export function validateRepoForm(
  values: RepoFormValues,
): FormResult<CreateRepoRequest, keyof RepoFormValues> {
  const defaultBranch = values.defaultBranch.trim();
  return validate(CreateRepoInput, {
    owner: values.owner.trim(),
    name: values.name.trim(),
    ...(defaultBranch !== "" && { defaultBranch }),
  });
}
