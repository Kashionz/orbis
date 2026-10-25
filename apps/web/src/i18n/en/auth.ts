import type { Messages } from "../types";

export default {
  signInWithGitHub: "Sign in with GitHub",
  inviteError: {
    invite_not_found:
      "This invite wasn't found. The link may have been used already or is incorrect.",
    invite_expired: "This invite has expired. Ask for a new one.",
    invite_revoked: "This invite was revoked.",
    invite_email_mismatch:
      "This invite isn't for the GitHub account you're signed in with (the verified email doesn't match).",
    unknown: "This invite can't be opened.",
    switchAccount: "Sign in with another GitHub account",
  },
} satisfies Messages["auth"];
