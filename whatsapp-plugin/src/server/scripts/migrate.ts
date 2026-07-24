import { loadConfig } from "../config.js";
import { createDatabase } from "../db/database.js";
import { migrate } from "../db/migrate.js";

const database = await createDatabase(loadConfig());
await migrate(database);
await database.close();
console.log("Database migration completed");

