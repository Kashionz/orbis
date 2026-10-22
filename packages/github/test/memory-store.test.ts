// InMemoryGitHubStore 跑 GitHubStore 的契約測試（Server 的 Drizzle 實作也跑同一組）。

import { InMemoryGitHubStore } from "../src/testing";
import { describeGitHubStoreContract } from "../src/testing/store-contract";

describeGitHubStoreContract("InMemoryGitHubStore", async () => new InMemoryGitHubStore());
