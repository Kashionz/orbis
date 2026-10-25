import type { Messages } from "../types";
import admin from "./admin";
import auth from "./auth";
import board from "./board";
import common from "./common";
import draftTasks from "./draftTasks";
import labels from "./labels";
import needsYou from "./needsYou";
import newTask from "./newTask";
import notifications from "./notifications";
import project from "./project";
import repoSpec from "./repoSpec";
import settings from "./settings";
import share from "./share";
import shell from "./shell";
import version from "./version";
import workspace from "./workspace";

export const en: Messages = {
  common,
  labels,
  shell,
  settings,
  newTask,
  share,
  admin,
  project,
  draftTasks,
  repoSpec,
  notifications,
  auth,
  version,
  workspace,
  board,
  needsYou,
};
