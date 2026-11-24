import type { Pool, RowDataPacket } from "mysql2/promise";

/**
 * 启动时校验「JS 时间」与「数据库 NOW()」是不是同一个时钟。
 *
 * 背景（2026-11-20 生产事故）：后端容器跑在 UTC，MySQL 容器跑在 CST(+8)。
 * 业务时间列由 JS 的 Date 写入，mysql2 按进程时区序列化 → 库里存的是 UTC 挂钟时间；
 * 而 SQL 里的 NOW(3) 走会话时区（CST）。两边差 8 小时，直接导致
 *   ① CLI 配对码一生成就「已过期」；② Runner 任务租约刚拿到就被回收；③ 审批请求立即过期。
 *
 * 上面这些点已改成 UTC_TIMESTAMP(3)，但同类错误很容易再写出来。这里在启动时把
 * 偏差算出来打一行日志，下次再出现时不用猜。
 */
export async function reportDatabaseClockSkew(pool: Pool) {
  try {
    const [rows] = await pool.query<Array<RowDataPacket & { offset_minutes: number; session_tz: string }>>(
      `SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offset_minutes, @@session.time_zone AS session_tz`
    );
    const minutes = Number(rows[0]?.offset_minutes || 0);
    const tz = String(rows[0]?.session_tz || "SYSTEM");
    if (Math.abs(minutes) < 1) return { minutes, tz, warned: false };
    console.warn(
      `[clock] 数据库会话时区是 ${tz}，NOW() 与 UTC 相差 ${minutes} 分钟。` +
      "JS 写入的时间列是 UTC，凡是拿 NOW()/CURDATE() 和这些列比较的 SQL 都会错位；" +
      "比较请用 UTC_TIMESTAMP()/UTC_DATE()。"
    );
    return { minutes, tz, warned: true };
  } catch {
    // 时钟体检只是提示，不能因为它失败挡住启动
    return null;
  }
}
