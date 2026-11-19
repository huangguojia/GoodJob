// 节奏轮询的 owner 缓存回归：空闲时 tick 不得反复扫 channel_accounts；
// 账号写路径（createAccount）bump 编号后，下一个 tick 必须重新读。
import { describe, expect, it } from "vitest";
import { Repository, getChannelAccountsEpoch } from "../src/server/db/repository.js";
import { AutomationRhythmService } from "../src/server/services/automation-rhythm.js";
import type { Database } from "../src/server/db/database.js";

function makeFakeDatabase() {
  const queries: string[] = [];
  const database: Database = {
    kind: "mysql",
    async query<Row>(text: string): Promise<{ rows: Row[] }> {
      queries.push(text);
      return { rows: [] as Row[] };
    },
    async exec(): Promise<void> {},
    async transaction<Result>(callback: (tx: Database) => Promise<Result>): Promise<Result> {
      return callback(database);
    },
    async close(): Promise<void> {}
  };
  return { database, queries };
}

describe("automation rhythm owner cache", () => {
  it("编号没变时 tick 复用 owner 缓存，写账号后重新读", async () => {
    const { database, queries } = makeFakeDatabase();
    const repository = new Repository(database);
    const service = new AutomationRhythmService(repository, undefined as never, "http://crm.invalid", undefined);

    const countAccountsQueries = () => queries.filter((q) => q.includes("channel_accounts")).length;

    await service.tick();
    const afterFirst = countAccountsQueries();
    expect(afterFirst).toBeGreaterThan(0);

    await service.tick();
    await service.tick();
    expect(countAccountsQueries()).toBe(afterFirst);

    const before = getChannelAccountsEpoch();
    await repository.createAccount({ name: "探针账号", provider: "meta" });
    expect(getChannelAccountsEpoch()).not.toBe(before);

    await service.tick();
    expect(countAccountsQueries()).toBeGreaterThan(afterFirst);

    await service.tick();
    expect(countAccountsQueries()).toBe(countAccountsQueries());
  });
});
