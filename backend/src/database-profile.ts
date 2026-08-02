export type DatabaseProfile =
  | "personal"
  | "development"
  | "test"
  | "production";

export interface DatabaseProfileInfo {
  profile: DatabaseProfile;
  database: string;
}

const TEST_DATABASE_PATTERN =
  /^goodjob_[a-z0-9_]*_test_[a-z0-9]+$/u;

function configuredDatabaseUrl(env: NodeJS.ProcessEnv) {
  return String(env.DATABASE_URL || env.MYSQL_URL || "").trim();
}

function databaseName(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL 或 MYSQL_URL 格式无效");
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//u, "")).trim();
  if (!name || !/^[A-Za-z0-9_$-]+$/u.test(name)) {
    throw new Error("数据库连接必须包含有效的数据库名称");
  }
  return name;
}

export function assertDatabaseProfile(
  env: NodeJS.ProcessEnv = process.env,
  rawUrl = configuredDatabaseUrl(env)
): DatabaseProfileInfo {
  if (!rawUrl) throw new Error("MySQL 模式必须配置 DATABASE_URL 或 MYSQL_URL");
  const profile = String(env.APP_DATABASE_PROFILE || "").trim() as DatabaseProfile;
  if (!["personal", "development", "test", "production"].includes(profile)) {
    throw new Error(
      "MySQL 模式必须显式配置 APP_DATABASE_PROFILE="
      + "personal、development、test 或 production"
    );
  }
  const database = databaseName(rawUrl);
  const seedEnabled = env.CRM_SEED_DEVELOPMENT_DATA === "true";

  if (profile === "personal" && database !== "goodjob_crm_personal") {
    throw new Error("个人档位只能连接 goodjob_crm_personal");
  }
  if (profile === "development" && database !== "goodjob_crm_dev") {
    throw new Error("开发档位只能连接 goodjob_crm_dev");
  }
  if (profile === "test" && !TEST_DATABASE_PATTERN.test(database)) {
    throw new Error("测试档位只能连接带随机后缀的 goodjob_*_test_* 临时库");
  }
  if (profile === "production" && [
    "goodjob_crm_personal",
    "goodjob_crm_dev"
  ].includes(database)) {
    throw new Error("生产档位不能连接个人库或开发库");
  }
  if (["personal", "production"].includes(profile) && seedEnabled) {
    throw new Error("个人库和生产库禁止启用 CRM_SEED_DEVELOPMENT_DATA");
  }
  if (profile === "personal" && env.NODE_ENV === "test") {
    throw new Error("测试进程禁止连接个人数据库");
  }
  if (profile === "test" && env.NODE_ENV !== "test") {
    throw new Error("测试数据库只能由 NODE_ENV=test 的进程使用");
  }
  return { profile, database };
}

