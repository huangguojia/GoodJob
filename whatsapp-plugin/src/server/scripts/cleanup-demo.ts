import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "../db/database.js";
import {
  applyDemoCleanup,
  planDemoCleanup,
  type DemoCleanupPlan,
  type DemoCleanupResult
} from "../db/demo-cleanup.js";

export interface CleanupCliOptions {
  apply: boolean;
  planDigest?: string;
}

function argumentValue(arguments_: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function parseCleanupCliOptions(arguments_: string[]): CleanupCliOptions {
  const unknown = arguments_.filter(
    (argument) => argument !== "--apply" && !argument.startsWith("--plan-digest=")
  );
  if (unknown.length > 0) throw new Error("Unknown cleanup argument");

  const apply = arguments_.includes("--apply");
  const planDigest = argumentValue(arguments_, "--plan-digest");
  if (apply && !planDigest) {
    throw new Error("--apply requires --plan-digest=<digest> from the latest dry-run");
  }
  if (!apply && planDigest) {
    throw new Error("--plan-digest can only be used together with --apply");
  }
  return { apply, planDigest };
}

export async function runCleanup(
  database: Database,
  options: CleanupCliOptions
): Promise<DemoCleanupPlan | DemoCleanupResult> {
  return options.apply
    ? applyDemoCleanup(database, options.planDigest!)
    : planDemoCleanup(database);
}

async function main(): Promise<void> {
  const { apply, planDigest } = parseCleanupCliOptions(process.argv.slice(2));
  const config = loadConfig();
  const database = await createDatabase(config);
  try {
    const report = await runCleanup(database, { apply, planDigest });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }, null, 2));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
