import assert from "node:assert/strict";
import type { Pool } from "mysql2/promise";
import { MysqlIntegrationRepository } from "./integration-repository.js";

const rows = [
  {
    id: "connection_a",
    connector_id: "connector_fake",
    team_id: "team_a",
    owner_id: "sales_a",
    connection_scope: "personal",
    scope_id: "sales_a",
    connection_status: "active",
    display_name: "Team A personal connection",
    revision_no: 1,
    last_health_at: null,
    last_error_code: "",
    last_error_message: "",
    created_at: new Date("2026-08-07T00:00:00.000Z"),
    updated_at: new Date("2026-08-07T00:00:00.000Z"),
    disconnected_at: null
  },
  {
    id: "connection_b",
    connector_id: "connector_fake",
    team_id: "team_b",
    owner_id: "sales_b",
    connection_scope: "personal",
    scope_id: "sales_b",
    connection_status: "active",
    display_name: "Team B personal connection",
    revision_no: 1,
    last_health_at: null,
    last_error_code: "",
    last_error_message: "",
    created_at: new Date("2026-08-07T00:00:00.000Z"),
    updated_at: new Date("2026-08-07T00:00:00.000Z"),
    disconnected_at: null
  }
];

const observedQueries: Array<{ sql: string; values: unknown[] }> = [];
const pool = {
  query: async (sql: string, values: unknown[] = []) => {
    observedQueries.push({ sql, values });
    let visible = rows.slice();
    const readsById = sql.includes("WHERE id = ?");
    if (sql.includes("team_id = ?")) visible = visible.filter((row) => row.team_id === values[readsById ? 1 : 0]);
    if (sql.includes("owner_id = ?")) visible = visible.filter((row) => row.owner_id === values[readsById ? 2 : 1]);
    if (readsById) visible = visible.filter((row) => row.id === values[0]);
    return [visible, []];
  }
} as unknown as Pool;

const repository = new MysqlIntegrationRepository(pool);
const personalA = await repository.listConnections({ type: "personal", teamId: "team_a", ownerId: "sales_a" });
assert.deepEqual(personalA.map((item) => item.id), ["connection_a"]);
const teamA = await repository.listConnections({ type: "team", teamId: "team_a" });
assert.deepEqual(teamA.map((item) => item.id), ["connection_a"]);
const platform = await repository.listConnections({ type: "platform" });
assert.deepEqual(platform.map((item) => item.id), ["connection_a", "connection_b"]);
assert.equal(await repository.getConnection("connection_b", { type: "team", teamId: "team_a" }), null);
assert.ok(observedQueries.every((query) => !query.sql.includes("SELECT * FROM integration_connections WHERE 1=1") || query.values.length === 2));

console.log(JSON.stringify({
  ok: true,
  personalScope: personalA.length,
  teamScope: teamA.length,
  platformScopeRequiresExplicitDecision: platform.length,
  crossTeamConnectionHidden: true
}, null, 2));
