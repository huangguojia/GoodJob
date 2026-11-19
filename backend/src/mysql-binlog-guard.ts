/**
 * MySQL binlog 守卫：本项目要求数据库必须关闭 binlog（log_bin = OFF）。
 *
 * MySQL 8.0 起 binlog 默认开启，只能在 mysqld 启动参数里关闭（--disable-log-bin / skip-log-bin），
 * 应用连上之后改不了。所以这里只做「检查」：
 *   - 生产环境（NODE_ENV=production）发现开启 → 抛错，拒绝启动，把修复方法写进错误信息；
 *   - 开发 / 测试环境 → 只打印警告，不影响本机开发。
 *
 * 项目自身不会开启 binlog，也不依赖 binlog（没有复制、没有基于 binlog 的备份或同步）。
 */

export interface BinlogQueryable {
  query(sql: string): Promise<unknown>;
}

export interface BinlogStatus {
  logBin: boolean;
  version: string;
}

export const BINLOG_DISABLED_HINT =
  "请在 mysqld 启动参数中加入 --disable-log-bin（Docker 部署见 deploy/docker-compose/compose.yml），"
  + "或在 my.cnf 的 [mysqld] 段加入 skip-log-bin，然后重启 MySQL。";

export async function readBinlogStatus(pool: BinlogQueryable): Promise<BinlogStatus> {
  const result = await pool.query("SELECT @@log_bin AS log_bin, @@version AS version");
  const rows = Array.isArray(result) ? result[0] : result;
  const row = (Array.isArray(rows) ? rows[0] : undefined) as { log_bin?: unknown; version?: unknown } | undefined;
  if (!row) throw new Error("无法读取 MySQL @@log_bin");
  const raw = row.log_bin;
  const logBin = raw === 1 || raw === "1" || raw === true || String(raw).toUpperCase() === "ON";
  return { logBin, version: String(row.version ?? "") };
}

export async function assertBinlogDisabled(
  pool: BinlogQueryable,
  options: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {}
): Promise<BinlogStatus> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const status = await readBinlogStatus(pool);
  if (!status.logBin) return status;
  const message = `MySQL binlog 处于开启状态（log_bin=ON，MySQL ${status.version}），本项目要求关闭。${BINLOG_DISABLED_HINT}`;
  if (env.NODE_ENV === "production") throw new Error(message);
  warn(`[GoodJob][警告] ${message}`);
  return status;
}
