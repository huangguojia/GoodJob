import { loadConfig } from "../config.js";
import { createDatabase } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { Repository } from "../db/repository.js";
import { seedDemo } from "../db/seed.js";

const config = loadConfig();
if (config.nodeEnv === "production") {
  throw new Error("Demo seed is disabled in production");
}

const database = await createDatabase(config);
try {
  await migrate(database);
  const report = await seedDemo(database, new Repository(database), config);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await database.close();
}
