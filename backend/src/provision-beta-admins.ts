import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { hashPassword } from "./auth.js";

interface BetaCredential {
  sequence: number;
  name: string;
  email: string;
  teamId: string;
  password: string;
}

const adminNames = [
  "启航团队管理员", "远帆团队管理员", "拓海团队管理员", "领航团队管理员", "晨星团队管理员",
  "云帆团队管理员", "瀚海团队管理员", "卓越团队管理员", "恒信团队管理员", "鼎盛团队管理员",
  "锐进团队管理员", "新程团队管理员", "博远团队管理员", "鸿图团队管理员", "嘉航团队管理员",
  "盛达团队管理员", "联创团队管理员", "华拓团队管理员", "海岳团队管理员", "星途团队管理员",
  "优贸团队管理员", "通达团队管理员", "汇川团队管理员", "宏景团队管理员", "凌云团队管理员",
  "致远团队管理员", "开拓团队管理员", "融通团队管理员", "盈海团队管理员", "创赢团队管理员",
  "经纬团队管理员", "寰宇团队管理员", "卓航团队管理员", "海纳团队管理员", "远见团队管理员",
  "同舟团队管理员", "凯程团队管理员", "万里团队管理员", "扬帆团队管理员", "峰航团队管理员"
];

function argumentValue(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function credentialFilePath() {
  return path.resolve(argumentValue("file") || process.env.BETA_ADMIN_CREDENTIALS_FILE || "./beta-admin-credentials.txt");
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const special = "!@#$%*-_";
  const bytes = randomBytes(20);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${body.slice(0, 7)}${special[bytes[0] % special.length]}${body.slice(7)}9aZ`;
}

function generateCredentials(): BetaCredential[] {
  return adminNames.map((name, index) => {
    const sequence = index + 1;
    const number = String(sequence).padStart(2, "0");
    return {
      sequence,
      name,
      email: `beta-admin-${number}@goodjob-crm.com`,
      teamId: `beta-${String(sequence).padStart(3, "0")}`,
      password: generatePassword()
    };
  });
}

function serializeCredentials(credentials: BetaCredential[]) {
  return [
    "序号\t管理员名称\t登录邮箱\t团队编号\t初始密码",
    ...credentials.map((item) => [item.sequence, item.name, item.email, item.teamId, item.password].join("\t"))
  ].join("\n") + "\n";
}

function parseCredentials(content: string): BetaCredential[] {
  const lines = content.trim().split(/\r?\n/).slice(1).filter(Boolean);
  const credentials = lines.map((line) => {
    const [sequence, name, email, teamId, password] = line.split("\t");
    return { sequence: Number(sequence), name, email, teamId, password };
  });
  if (credentials.length !== 40
    || credentials.some((item) => !item.sequence || !item.name || !item.email || !item.teamId || item.password.length < 16)
    || new Set(credentials.map((item) => item.email)).size !== 40
    || new Set(credentials.map((item) => item.teamId)).size !== 40
    || new Set(credentials.map((item) => item.password)).size !== 40) {
    throw new Error("公测管理员凭据文件格式错误，必须包含 40 组唯一且完整的账号");
  }
  return credentials;
}

async function loadOrCreateCredentials(filePath: string) {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("凭据路径不是普通文件");
    return parseCredentials(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const credentials = generateCredentials();
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, serializeCredentials(credentials), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(filePath, 0o600);
    return credentials;
  }
}

async function provision(credentials: BetaCredential[]) {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL 或 MYSQL_URL，无法写入 MySQL");
  const connection = await mysql.createConnection(databaseUrl);
  let created = 0;
  let skipped = 0;
  try {
    await connection.beginTransaction();
    for (const item of credentials) {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(
        "SELECT id,email,role,team_id FROM users WHERE email = ? OR (role = 'admin' AND team_id = ?) FOR UPDATE",
        [item.email, item.teamId]
      );
      if (rows.length) {
        const exact = rows.find((row) => row.email === item.email && row.role === "admin" && row.team_id === item.teamId);
        if (!exact || rows.length > 1) {
          throw new Error(`账号或团队冲突：${item.email} / ${item.teamId}`);
        }
        skipped += 1;
        continue;
      }
      const passwordHash = await hashPassword(item.password);
      await connection.execute(
        `INSERT INTO users
          (id,name,email,password_hash,role,team_id,avatar,status,auth_version)
         VALUES (?,?,?,?,? ,?,?,?,?)`,
        [
          `u_beta_admin_${String(item.sequence).padStart(3, "0")}`,
          item.name,
          item.email,
          passwordHash,
          "admin",
          item.teamId,
          `B${String(item.sequence).padStart(2, "0")}`,
          "active",
          1
        ]
      );
      created += 1;
    }
    await connection.commit();
    return { created, skipped };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

const filePath = credentialFilePath();
const credentials = await loadOrCreateCredentials(filePath);
if (process.argv.includes("--generate-only")) {
  console.log(`已生成并校验 40 组公测管理员凭据：${filePath}`);
} else {
  const result = await provision(credentials);
  console.log(`公测管理员预置完成：新增 ${result.created}，已存在 ${result.skipped}，凭据文件 ${filePath}`);
}
