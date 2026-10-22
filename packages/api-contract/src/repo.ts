// Repo（ARCHITECTURE §4）：登記在 Project 底下的一個 GitHub repository。

import { z } from "zod";
import { Id, Timestamp } from "./common";

export const Repo = z.object({
  id: Id,
  projectId: Id,
  /** GitHub 上的擁有者（使用者或組織）。 */
  owner: z.string().min(1),
  /** GitHub 上的 repository 名稱。 */
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Repo = z.infer<typeof Repo>;
