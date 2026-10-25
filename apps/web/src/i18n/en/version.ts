import type { Messages } from "../types";

export default {
  reload: "Reload",
  reloadMessage: (serverApi: number, localApi: number) =>
    `A new version of the interface is available. Reload the page (server API version ${serverApi}, loaded ${localApi})`,
  updateServerMessage: (server: string, serverApi: number, localApi: number) =>
    `The server is out of date. Update the server (server v${server} has API version ${serverApi}, the interface needs ${localApi})`,
  noVersionsMessage: "The server is out of date. Update the server (it doesn't report a version)",
} satisfies Messages["version"];
