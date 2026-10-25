import type { Messages } from "../types";

export default {
  section: "Repo specs",
  sectionHint:
    "Markdown specs in the repo. Edit the draft together here, then commit to the repo to open a PR.",
  noSpecs: "No specs registered yet.",
  version: (n: number) => `Version ${n}`,
  openPullRequest: (n: number) => `PR #${n} not merged`,
  registerForm: (repo: string) => `Register a spec in ${repo}`,
  path: "Spec path",
  pathHint:
    "Relative path in the repo separated by /, ending in .md. A missing file is created on commit.",
  titleOptional: "Title (optional)",
  register: "Register spec",

  projectFallback: "Project",
  repoFallback: "Repo",
  draftHint:
    "This is a shared draft of the spec. A PR is opened only when it's committed to the repo. Agents that change the spec open their own PR and don't overwrite the draft.",
  editorLabel: "Spec draft",
  prCreated: "Opened PR:",
  prUpdated: "Updated PR:",
  prOpen: "Open spec PR:",
  overwritesUpstream: (path: string) =>
    `${path} on the default branch changed after the last version. This PR overwrites those changes; check before merging.`,
  commit: "Commit to repo",
  commitMessage: "Commit message (optional)",
  commitPlaceholder: (path: string) => `docs: update ${path}`,
} satisfies Messages["repoSpec"];
