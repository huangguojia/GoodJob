# GoodJob CRM Windows 一键启动与安全更新设计

## 交付目标

该交付包面向不具备开发环境的 Windows 用户。用户完整解压 ZIP 后双击 `START-GOODJOB.cmd` 即可运行，不需要预装 Node.js、npm、MySQL、MariaDB、PostgreSQL、Docker 或 PowerShell 7，也不会注册 Windows 服务。

支持范围：Windows 10 1809 及以上、Windows 11、x64。首次启动需要有权写入当前用户的 `%LOCALAPPDATA%`，不需要管理员权限。

## 包内与电脑内的边界

包内只携带运行所需内容：

- Node.js 22 Windows x64 的 `node.exe`。
- MariaDB 11.4 LTS Windows x64 便携运行时、客户端和 `mariadb-dump.exe`。
- CRM 后端编译产物、前端静态文件、生产依赖。
- Communication 后端编译产物、前端静态文件、生产依赖。
- 必要的 Agent skills、knowledge、许可证和运行脚本。

不会安装或修改：

- 系统 Node.js、npm、MySQL、MariaDB、PostgreSQL。
- Windows 服务、注册表、系统 PATH、环境变量。
- 防火墙入站规则；三个服务只监听 `127.0.0.1`。
- 用户电脑上其他 Node 或数据库进程。

构建时排除源码、测试、文档、开发依赖、Vite、TypeScript、Playwright、npm 缓存、数据库、日志、备份、`.env`、`.git` 和 `.svn`。第三方依赖只保留 Windows x64 原生模块。

## 数据目录

所有用户数据都在应用目录之外：

```text
%LOCALAPPDATA%\GoodJobCRM
├─ config
│  ├─ runtime.env
│  ├─ secrets.env
│  ├─ mariadb-root.ini
│  ├─ mariadb-app.ini
│  ├─ update-config.json
│  └─ 首次登录账号.txt
├─ data
│  ├─ mysql
│  ├─ uploads
│  └─ communication
├─ logs
├─ backups\database
├─ releases
├─ runtime
└─ updates
```

删除或替换程序 ZIP 不会删除业务数据。需要迁移电脑时，应在停止服务后完整复制 `%LOCALAPPDATA%\GoodJobCRM`。

## 双击启动流程

启动器固定使用 CRM `4188`、Communication `3100`、MariaDB `13306`。端口冲突时直接报告占用 PID，不自动漂移，避免连接到其他数据库或导致 CORS、书签和更新状态不一致。

启动阶段会实时显示并写入日志：

1. 检查 Windows 版本和 x64 架构。
2. 检查 Node、MariaDB 与应用运行文件。
3. 创建独立数据目录，首次生成随机数据库密码、JWT、加密密钥和随机管理员密码。
4. 检查三个固定端口。
5. 初始化 MariaDB 数据目录。
6. 启动只监听 `127.0.0.1` 的 MariaDB。
7. 创建 `goodjob_crm` 和最小权限用户 `goodjob_app@127.0.0.1`。
8. 执行 CRM 幂等迁移。
9. 执行 Communication MySQL 迁移。
10. 以独立 PID 启动 Communication 和 CRM。
11. 依次验证两个健康检查。
12. 打开浏览器。

首次账号写入 `%LOCALAPPDATA%\GoodJobCRM\config\首次登录账号.txt`，仅当前 Windows 用户和 SYSTEM 可读。用户登录后应立即修改密码。

## 启停和故障日志

- `START-GOODJOB.cmd`：启动，若已运行则只打开浏览器。
- `STOP-GOODJOB.cmd`：按状态文件中的 PID 精确停止，不使用 `taskkill /im node.exe`。
- `DIAGNOSE-GOODJOB.cmd`：检查运行时、配置、数据库、PID、健康接口，汇总最近日志。
- `UPDATE-GOODJOB.cmd`：执行与系统设置按钮相同的安全更新事务。

日志位于 `%LOCALAPPDATA%\GoodJobCRM\logs`。启动器为每次执行生成带时间戳的主日志；MariaDB、CRM、Communication 分别保存标准输出和错误日志。失败时控制台显示失败阶段、原因和日志路径。

## 镜像源格式

系统设置保存的是 `manifest.json` 所在目录。公网源必须是 HTTPS；测试环境可使用 Windows 绝对目录。镜像目录示例：

```text
mirror
├─ manifest.json
├─ manifest.sig
└─ releases\1.2.5\goodjob-app-1.2.5-win-x64.zip
```

`manifest.json` 格式版本为 2：

```json
{
  "packageFormatVersion": 2,
  "latestVersion": "1.2.5",
  "minimumVersion": "1.2.4",
  "releases": {
    "1.2.5": {
      "date": "2026-08-02",
      "databaseCompatibility": "backward-compatible",
      "windows": {
        "url": "releases/1.2.5/goodjob-app-1.2.5-win-x64.zip",
        "size": 123456,
        "sha256": "64位十六进制摘要"
      },
      "changelog": "更新内容"
    }
  }
}
```

正式镜像必须用 Ed25519 私钥对 `manifest.json` 原始字节签名，Base64 结果写入 `manifest.sig`。公钥在构建便携包时通过 `GOODJOB_UPDATE_PUBLIC_KEY` 嵌入。私钥不得进入源码、安装包或服务器 Web 根目录。

当前项目签名私钥默认保存在开发机的 `~/.goodjob-crm-release-keys/update-ed25519-private.pem`，权限为 `0600`；公钥位于 `scripts/windows/update-public-key.pem`。私钥丢失后，已分发的安装包将无法验证新版本，因此必须离线备份，但严禁提交 SVN。

## 安全更新事务

更新顺序不可跳过：

1. 获取更新单实例锁。
2. 校验镜像地址、清单格式和 Ed25519 签名。
3. 使用包内 `mariadb-dump.exe` 创建一致性 SQL 备份。
4. 检查备份文件大小并计算 SHA256；失败立即中止。
5. 下载完整 Windows 应用包，限制最大 1.5GB。
6. 同时核对 Content 大小和 SHA256。
7. 拒绝 ZIP 绝对路径或 `..` 路径穿越。
8. 解压到 staging，并逐文件核验 `PACKAGE-MANIFEST.sha256`。
9. 停止 CRM 与 Communication，数据库继续运行。
10. 对新版本执行 CRM 与 Communication 幂等迁移；任一迁移失败就停止。
11. 原子写入 active release 指针并启动新版本。
12. 验证健康接口；失败时切回旧代码并重启旧版本。

数据库迁移必须保持向后兼容。代码自动回滚不等同于自动恢复数据库；更新前的 `.sql.gz`、大小与 SHA256 会显示在界面并保留，确需恢复时必须先停止服务、核对目标库并由管理员执行恢复。

## 构建与发布

构建完整便携包：

```bash
GOODJOB_UPDATE_PUBLIC_KEY=/secure/update-public-key.pem \
  ./scripts/build-windows-portable.sh 1.2.5
```

生成签名更新镜像：

```bash
GOODJOB_UPDATE_PRIVATE_KEY=/secure/update-private-key.pem \
  ./scripts/packaging/make-update.sh 1.2.5 /path/to/mirror https://download.example.com/goodjob/
```

镜像 Web 服务器应提供 HTTPS、正确的文件长度、`application/json` 和 ZIP 下载，并避免缓存 `manifest.json`；版本 ZIP 可使用长期不可变缓存。

## Windows 发布前验收

每个版本仍需在干净的 Windows 10 x64 和 Windows 11 x64 虚拟机各做一次最终冒烟：

- 无 Node/MySQL 时首次启动成功，且不需要管理员权限。
- 电脑已有 Node/MySQL 时不受影响，停止后原进程仍在。
- 数据写入后重启仍存在，程序目录替换后仍存在。
- 端口冲突显示 PID 且不连接其他数据库。
- 路径含空格和中文时启动、备份、更新均成功。
- 断网、哈希错误、签名错误、备份失败、迁移失败、健康失败均按预期中止或回滚。
- Communication 页面、API、上传和 Socket.IO 实时消息在 CRM 单一地址下可用。
