/**
 * 发信副本归档到「已发送」回归测试。
 *
 * 覆盖 2026-09-29 的真实问题：CRM 台账显示已发（`sent`、无退信），用户在自己邮箱的
 * 「已发送」里却一封都找不到——腾讯企业邮在网页端未勾选「保存已发送至服务器」时，
 * 不会保存 SMTP 客户端投递的邮件。这里保证归档模块的判定逻辑不出错，
 * 尤其是**绝不能在测试环境真的去连邮箱**。
 */
import {
  archiveMessageToSentFolder,
  describeSentFolderTarget,
  deriveImapHostFromSmtpHost,
  isAlreadySavedByServer,
  pickSentFolderPath,
  resolveSentFolderTarget,
  sentFolderArchiveEnabled
} from "./sent-folder-archive.js";

let checked = 0;
function check(condition: unknown, message: string) {
  checked += 1;
  if (!condition) throw new Error(`AssertionError: ${message}`);
}

async function main() {
  /* ---- 1) IMAP 主机推导：只认「smtp」作为独立标签 ---- */
  const hostCases: Array<[string, string]> = [
    ["smtp.exmail.qq.com", "imap.exmail.qq.com"],
    ["smtp.qiye.aliyun.com", "imap.qiye.aliyun.com"],
    ["SMTP.Exmail.QQ.com", "imap.exmail.qq.com"],
    ["mail.smtp.example.com", "mail.imap.example.com"],
    ["  smtp.example.com  ", "imap.example.com"],
    ["", ""],
    // 下面这些推不出来就该放弃，不能瞎猜主机（连错服务器会触发登录风控）
    ["smtp-relay.example.com", ""],
    ["smtp-mail.outlook.com", ""],
    ["example.com", ""]
  ];
  for (const [input, expected] of hostCases) {
    const actual = deriveImapHostFromSmtpHost(input);
    check(actual === expected, `「${input}」应推导为「${expected}」，实际「${actual}」`);
  }

  /* ---- 2) 归档目标解析 ---- */
  const derived = resolveSentFolderTarget({
    id: "u_admin",
    smtpHost: "smtp.exmail.qq.com",
    smtpUser: "huangguojia@longtec.com",
    smtpPassword: "authorization-code"
  });
  check(derived?.host === "imap.exmail.qq.com", "只配 SMTP 时应推导出 IMAP 主机");
  check(derived?.port === 993, "IMAP 端口默认 993");
  check(derived?.secure === true, "IMAP 默认走 SSL");
  check(derived?.derived === true, "推导所得要标记出来（便于排查）");
  check(derived?.user === "huangguojia@longtec.com", "应复用 SMTP 账号");
  check(derived?.password === "authorization-code", "应复用 SMTP 授权码（实测同一串可同时登 SMTP 与 IMAP）");

  const explicit = resolveSentFolderTarget({
    id: "u_manager",
    imapHost: "imap.custom.com",
    imapPort: 143,
    imapSecure: false,
    imapUser: "imap@custom.com",
    imapPassword: "imap-pwd",
    smtpHost: "smtp.exmail.qq.com",
    smtpUser: "smtp@custom.com",
    smtpPassword: "smtp-pwd"
  });
  check(explicit?.host === "imap.custom.com", "显式配置的 IMAP 主机优先于推导");
  check(explicit?.port === 143 && explicit?.secure === false, "显式端口与加密方式要生效");
  check(explicit?.user === "imap@custom.com" && explicit?.password === "imap-pwd", "显式 IMAP 凭据优先");
  check(explicit?.derived === false, "显式配置不应标成推导");

  check(
    resolveSentFolderTarget({ id: "u", smtpHost: "mail.example.com", smtpUser: "a@b.com", smtpPassword: "p" }) === null,
    "推不出 IMAP 主机时应放弃归档"
  );
  check(
    resolveSentFolderTarget({ id: "u", smtpHost: "smtp.example.com", smtpUser: "a@b.com" }) === null,
    "没有密码时应放弃归档"
  );
  check(
    resolveSentFolderTarget({ id: "u", smtpHost: "smtp.example.com", smtpPassword: "p" }) === null,
    "没有账号时应放弃归档"
  );

  /* ---- 3) 开关：测试环境绝不能真连邮箱 ---- */
  check(sentFolderArchiveEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv) === false, "测试环境必须关闭归档");
  check(sentFolderArchiveEnabled({ NODE_ENV: "e2e" } as NodeJS.ProcessEnv) === false, "e2e 环境必须关闭归档");
  check(sentFolderArchiveEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv) === true, "生产环境默认开启");
  check(sentFolderArchiveEnabled({} as NodeJS.ProcessEnv) === true, "默认开启");
  for (const off of ["false", "0", "off", "no", "FALSE", " off "]) {
    check(
      sentFolderArchiveEnabled({ OUTBOUND_EMAIL_ARCHIVE_TO_SENT: off } as NodeJS.ProcessEnv) === false,
      `「${off}」应能关闭归档`
    );
  }
  check(
    sentFolderArchiveEnabled({ OUTBOUND_EMAIL_ARCHIVE_TO_SENT: "true" } as NodeJS.ProcessEnv) === true,
    "显式开启仍然有效"
  );

  /* ---- 4) 「已发送」文件夹识别 ---- */
  check(
    pickSentFolderPath([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Sent Messages", specialUse: "\\Sent" },
      { path: "Drafts", specialUse: "\\Drafts" }
    ]) === "Sent Messages",
    "应认 IMAP 的 \\Sent 标记（腾讯企业邮的 path 正是 Sent Messages）"
  );
  check(pickSentFolderPath([{ path: "INBOX" }, { path: "Sent" }]) === "Sent", "无标记时按名称兜底");
  check(pickSentFolderPath([{ path: "INBOX" }, { path: "sent messages" }]) === "sent messages", "名称匹配忽略大小写");
  check(pickSentFolderPath([{ path: "INBOX" }, { path: "已发送" }]) === "已发送", "中文「已发送」兜底");
  check(pickSentFolderPath([{ path: "INBOX" }, { path: "已发送邮件" }]) === "已发送邮件", "中文「已发送邮件」兜底");
  check(pickSentFolderPath([{ path: "INBOX" }, { path: "My Sent Stuff" }]) === "My Sent Stuff", "宽松匹配");
  check(pickSentFolderPath([{ path: "INBOX" }, { path: "Drafts" }]) === "", "找不到已发送时应返回空串");
  check(pickSentFolderPath([]) === "", "文件夹列表为空时返回空串");

  /* ---- 5) 描述信息脱敏 ---- */
  const described = describeSentFolderTarget({
    host: "imap.exmail.qq.com",
    port: 993,
    secure: true,
    user: "huangguojia@longtec.com",
    password: "top-secret-pwd",
    derived: true
  });
  check(!described.includes("top-secret-pwd"), "描述里绝不能出现密码");
  check(described.includes("imap.exmail.qq.com"), "描述应包含主机，便于日志排查");
  check(describeSentFolderTarget(null).includes("未配置"), "没有可用目标时应给出可读说明");

  /* ---- 6) 「服务端已自行保存」识别（腾讯企业邮开启该开关后 APPEND 会被拒）---- */
  // 真实形状：imapflow 抛出的错误对象
  check(
    isAlreadySavedByServer({
      message: "Command failed",
      response: "9 NO Mail has saved by smtp!",
      responseText: "Mail has saved by smtp!"
    }),
    "应识别腾讯企业邮的「Mail has saved by smtp!」（这是已保存，不是失败）"
  );
  check(
    isAlreadySavedByServer({ message: "IMAP 命令 APPEND 失败：Mail has saved by smtp!" }),
    "message 里带该字样也应识别"
  );
  check(isAlreadySavedByServer({ response: "9 NO MAIL HAS SAVED BY SMTP!" }), "应忽略大小写");
  check(!isAlreadySavedByServer({ message: "连接邮箱超时" }), "普通超时不能被误判成已保存");
  check(!isAlreadySavedByServer({ message: "Authentication failed" }), "认证失败不能被误判");
  check(!isAlreadySavedByServer(new Error("socket closed")), "普通 Error 不能被误判");
  check(!isAlreadySavedByServer(null) && !isAlreadySavedByServer(undefined), "空值不能误判");

  /* ---- 7) 测试环境下调用必须是空操作（不建连接、不阻塞） ---- */
  const skipped = await archiveMessageToSentFolder(
    { id: "u_test", smtpHost: "smtp.exmail.qq.com", smtpUser: "a@b.com", smtpPassword: "p" },
    Buffer.from("Subject: probe\r\n\r\nbody")
  );
  check(skipped.ok === false && skipped.skipped === true, "测试环境必须直接跳过归档，不能真连邮箱");

  console.log(JSON.stringify({ ok: true, checked }, null, 2));
}

main();
