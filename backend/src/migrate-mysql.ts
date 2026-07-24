import { migrateMysqlSchema } from "./mysql-store.js";

async function main() {
  const result = await migrateMysqlSchema();
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MySQL 增量迁移失败");
  process.exitCode = 1;
});
