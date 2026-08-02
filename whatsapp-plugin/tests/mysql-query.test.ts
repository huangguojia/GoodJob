import { describe, expect, it } from "vitest";
import { compileMysqlQuery } from "../src/server/db/database";

describe("MySQL query compilation", () => {
  it("reorders and repeats PostgreSQL-style parameters without changing their values", () => {
    expect(compileMysqlQuery("SELECT $2,$1,$2::text", ["first", "second"])).toEqual({
      text: "SELECT ?,?,?",
      params: ["second", "first", "second"]
    });
  });

  it("removes portable result casts and PostgreSQL null ordering", () => {
    expect(compileMysqlQuery("SELECT count(*)::int FROM messages ORDER BY occurred_at DESC NULLS LAST")).toEqual({
      text: "SELECT count(*) FROM messages ORDER BY occurred_at DESC",
      params: []
    });
  });

  it("fails closed when a placeholder has no corresponding value", () => {
    expect(() => compileMysqlQuery("SELECT $2", ["only-one"])).toThrow(/Missing SQL parameter/u);
  });
});
