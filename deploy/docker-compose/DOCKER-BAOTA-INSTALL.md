# GoodJob CRM 独立 Docker Compose + 宝塔部署手册

本方案只借用宿主机的 Docker daemon 和 GoodJob 专属宝塔网站。GoodJob 自带
统一 MySQL 8.4、CRM、Communication 和内部 Nginx，不连接也不修改宿主机已有的
MySQL 5.7、PostgreSQL 或其他容器。Communication 与 CRM 共用一个 MySQL 数据库。

## 1. 资源边界

GoodJob 只创建以下资源：

- Compose 项目：`goodjobcrm`
- 容器：名称以 `goodjobcrm-` 开头
- 网络：`goodjobcrm_private`
- 卷：`goodjobcrm_mysql_data`、`goodjobcrm_uploads_data`、`goodjobcrm_communication_media`
- 宿主机监听：仅 `127.0.0.1:4188`
- 持久配置：`/opt/goodjobcrm/shared`
- 宝塔变更：仅 GoodJob 专属域名的网站反向代理

不会开放或占用宿主机的 `3306`、`5432`、`3100`，也不会重启 Docker daemon。
从旧双数据库版本升级时，已有 `goodjobcrm_postgres_data` 只会临时挂到
`legacy-migration` profile 完成备份、迁移和校验，随后立即停止；数据卷保留作回滚。

## 2. 安装前需要准备

你只需要准备：

1. GoodJob 专属域名。
2. 该域名是否已在宝塔启用 HTTPS。
3. 首个超级管理员的邮箱、姓名和至少 12 位密码。姓名暂用英文字母、数字、点、
   下划线或连字符，登录后可以在系统中调整展示信息。

服务器应满足：Docker Engine 正常、Docker Compose v2、至少 10 GiB 可用磁盘、
至少 2 GiB 可用内存。8 GiB 服务器建议增加 2–4 GiB Swap，但不要在未获得
机主同意时调整系统 Swap。

先记录已有服务，命令全部只读：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker network ls
docker volume ls
ss -lntp
free -h
df -h
```

## 3. 推荐方式：服务器只拉取一次私人 SVN

你不需要每次重新上传压缩包。服务器安装 Docker、Subversion 后，第一次执行：

```bash
svn checkout svn://gitee.com/sendoh-huang/good-job-private /opt/goodjobcrm-src
cd /opt/goodjobcrm-src
chmod +x deploy/docker-compose/*.sh update-docker.sh
./deploy/docker-compose/update-from-svn.sh
```

第一次 `svn checkout` 会向你询问私人仓库凭据。配置脚本只在服务器本地保存域名、
密钥和管理员密码，不会写回 SVN。

后续更新只需执行：

```bash
cd /opt/goodjobcrm-src
./update-docker.sh
```

更新动作是固定顺序：检查 SVN 工作副本无本地修改、拉取最新提交、在 Node.js Docker
构建器中编译、备份 MySQL/上传文件/媒体、执行幂等迁移、启动新容器、健康检查。失败时
不会删除数据库和数据卷，可查看日志后重试或执行应用镜像回滚。应用健康检查失败时，
脚本会尝试恢复上一版应用镜像；数据库结构迁移不自动反向回滚，必须使用备份恢复。
默认保留最近 10 份完整备份和当前/上一版应用镜像，避免长期更新撑满服务器磁盘。

如果服务器只允许使用安装包，也可以使用下面的压缩包方式。

## 4. 上传与校验部署包

在本机上传压缩包和 `.sha256` 文件到服务器 `/root`。服务器执行：

```bash
cd /root
sha256sum -c GoodJob-CRM-Docker-*.tar.gz.sha256
tar -xzf GoodJob-CRM-Docker-*.tar.gz
cd GoodJob-CRM-Docker-*
```

校验必须显示 `OK`。不要把旧宝塔部署包和 Docker 部署包混用。

## 5. 首次配置

```bash
./configure.sh
```

脚本依次询问域名、HTTPS 状态和首个管理员信息。数据库密码和生产密钥由
`openssl` 在服务器本地生成，保存在：

```text
/opt/goodjobcrm/shared/secrets
```

目录权限为 `700`，文件权限为 `600`。`configure.sh` 检测到已有配置时会拒绝
覆盖。不要把该目录、`deploy.env` 或终端中的密码发送给别人。

## 6. 安装前预检

```bash
./preflight.sh
```

脚本会停止安装而不是自动处理以下冲突：

- Docker/Compose 不可用；
- 可用内存或磁盘不足；
- `4188` 被非 GoodJob 服务占用；
- 同名容器、卷或网络不属于 GoodJob；
- Compose 配置无效。

预检不会拉取镜像、创建容器、重启服务或修改 Nginx。

## 7. 构建并启动

```bash
./install.sh
```

首次安装会串行构建镜像，减少对现有业务的 CPU 和内存冲击。随后：

1. 从源码构建三个 GoodJob 镜像；
2. 创建统一 MySQL 8.4；
3. 为 CRM 与 Communication 执行幂等迁移；
4. 启动 CRM、Communication 和内部网关；
5. 验证 `http://127.0.0.1:4188/api/health`。

检查状态：

```bash
./manage.sh status
./manage.sh logs 200
```

不要使用 `docker compose down -v`，其中 `-v` 会删除 GoodJob 数据卷。

## 8. 接入宝塔网站

先在服务器验证：

```bash
curl -fsS http://127.0.0.1:4188/api/health
curl -I http://127.0.0.1:4188/
```

然后只修改 GoodJob 专属网站。在宝塔“网站 -> GoodJob 网站 -> 反向代理”中新增：

```text
代理名称：goodjobcrm
目标 URL：http://127.0.0.1:4188
发送域名：$host
缓存：关闭
```

必须开启 WebSocket，并把代理读取超时设为 `300` 秒。若宝塔界面无法使用，
让机主把 `baota-nginx.include.conf` 的 `location /` 内容放入该域名的 server 块。
不要编辑其他域名配置或 `/www/server/nginx/conf/nginx.conf`。

修改后验证并平滑加载：

```bash
/www/server/nginx/sbin/nginx -t
/www/server/nginx/sbin/nginx -s reload
```

`nginx -t` 失败时不要 reload，先恢复该网站配置备份。

## 9. HTTPS

未启用 SSL 时，首次配置选择 `N`。宝塔签发证书后修改：

```bash
nano /opt/goodjobcrm/shared/deploy.env
```

只改：

```ini
PUBLIC_SCHEME=https
PUBLIC_ORIGIN=https://实际域名
SESSION_COOKIE_SECURE=true
```

然后执行：

```bash
./install.sh
```

不要在 HTTPS 未生效前提前设置 `SESSION_COOKIE_SECURE=true`，否则浏览器无法保留
登录 Cookie。

## 10. 日常管理

```bash
./manage.sh status
./manage.sh logs 200
./manage.sh restart
./manage.sh stop
./manage.sh start
```

只停止 GoodJob：

```bash
./manage.sh stop
```

该操作不会停止数据库和其他项目容器。

## 11. 备份、升级与回滚

手动备份：

```bash
./backup.sh
```

备份保存在 `/opt/goodjobcrm/shared/backups/时间戳`，包含统一 MySQL、上传文件、Logo、
公章、签名、Communication 媒体、运行配置和密钥。备份等同于生产凭据，必须限制 root
访问，并复制到服务器外的安全位置。

升级步骤：

```bash
cd /root/新版本目录
GOODJOB_APP_ROOT=/opt/goodjobcrm ./preflight.sh
GOODJOB_APP_ROOT=/opt/goodjobcrm ./install.sh
```

检测到当前版本后，安装脚本会先备份统一 MySQL 再迁移。检测到旧 PostgreSQL
数据卷时，首次切换会备份并迁移；已有完成标记时只做源指纹与目标全内容复核，
任一侧变化都会停止。失败时不会删除数据库卷。

应用镜像回滚：

```bash
./rollback.sh
```

数据库恢复是破坏性操作，只在确认迁移造成数据问题时使用：

```bash
./restore.sh /opt/goodjobcrm/shared/backups/具体时间戳
```

恢复脚本会先校验备份摘要并自动备份当前统一 MySQL，然后只覆盖 GoodJob Compose
内的统一 MySQL，并补跑 CRM 与 Communication 两套结构迁移。它不会操作其他项目。

## 12. 安装后验收

```bash
./manage.sh status
docker ps --filter label=com.docker.compose.project=goodjobcrm
ss -lntp | grep ':4188[[:space:]]'
curl -fsS http://127.0.0.1:4188/api/health
curl -I "${PUBLIC_ORIGIN:-http://实际域名}/"
```

验收标准：MySQL、CRM、Communication 和网关为 `running/healthy`，PostgreSQL
不在运行列表；4188 只监听 `127.0.0.1`；3306、5432、3100 没有新增宿主机映射；
原有容器状态与安装前一致。
