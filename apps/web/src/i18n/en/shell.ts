import type { Messages } from "../types";

export default {
  mainNav: "Main navigation",
  searchPlaceholder: "Search tasks",
  searchLabel: "Search tasks",
  board: "Board",
  needsYou: "Needs you",
  notifications: "Notifications",
  needsYouCount: (n: number) => `${n} ${n === 1 ? "item" : "items"} waiting`,
  unreadCount: (n: number) => `${n} unread`,
  sections: {
    active: "In progress",
    pr: "PR Open",
    ready: "Ready",
    backlog: "Backlog",
    done: "Done",
  },
  noMatchingTasks: "No matching tasks",
  resizeSidebar: "Resize sidebar",
  resizePanel: "Resize panel",
  showPanel: "Show panel",
  hidePanel: "Hide panel",

  profileMenu: "Profile menu",
  settings: "Settings",
  runners: "Runners",
  admin: "Admin",
  signOut: "Sign out",
  noLocalRunner: "Not paired",

  notMemberTitle: "Not on a team yet",
  notMemberBody: (login: string) =>
    `Signed in with GitHub as ${login}, but not a member of any team yet.`,
  noProjects: "No projects yet",
} satisfies Messages["shell"];
