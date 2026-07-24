import { loadConfig } from "../config.js";
import { createDatabase } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { Repository } from "../db/repository.js";
import { seed } from "../db/seed.js";

const config = loadConfig();
const database = await createDatabase(config);
await migrate(database);
await seed(database, new Repository(database), config);
await database.close();
console.log("Database seed completed");

