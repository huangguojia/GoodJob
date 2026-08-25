# CRM 与 Communication 合并到 MySQL 的生产切换手册

本手册适用于当前宝塔部署：CRM 已使用 MySQL，Communication 仍使用 PostgreSQL。
目标是让两个服务共用同一个 MySQL 数据库和应用用户。迁移完成后，PostgreSQL
不再是 GoodJob 的运行依赖，但旧库必须保留一个回滚周期。

## 1. 合库后的边界

- CRM 与 Communication 使用同一条 MySQL `DATABASE_URL`。
- Communication 保留自己的 15 张业务表，不与当前 CRM 表重名。
- Communication 结构版本记录在 `communication_schema_migrations`。
- PostgreSQL 切换记录在 `communication_data_migrations`。
- Communication 表使用 `utf8mb4_bin`，保留 PostgreSQL 主键和幂等键的大小写语义。
- `SESSION_MASTER_KEY` 必须沿用旧值，否则历史会话和凭据无法解密。
- PostgreSQL 只在迁移窗口读取；安装器不会删除、清空或停止服务器的 PostgreSQL 服务。

## 2. 迁移工具的完成条件

一次迁移只有同时满足以下条件才算成功：

1. PostgreSQL 在 `REPEATABLE READ READ ONLY` 一致性快照中被读取。
2. 15 张业务表按主键分页写入同一个 MySQL 事务。
3. 每张表的行数、主键 SHA-256 和全内容 SHA-256 完全一致。
4. 账号、联系人、会话、消息、翻译和 Meta 凭据的外键关系不存在孤儿数据。
5. MySQL 写入 `postgres-to-mysql-v1` 完成标记。

任何一步失败都会回滚本次 MySQL 数据写入，不会修改 PostgreSQL。

## 3. 维护窗口前检查

以下命令只读取状态：

```bash
systemctl status goodjob-crm goodjob-crm-whatsapp --no-pager
grep -E '^(DATABASE_CLIENT|DATABASE_URL)=' \
  /www/server/goodjob-crm/shared/whatsapp-plugin.env
/www/server/mysql/bin/mysql --version
/www/server/pgsql/bin/pg_dump --version
ss -lntp | grep -E ':(3306|5432|4188|3100)[[:space:]]'
df -h /
```

确认旧环境显示 `DATABASE_CLIENT=postgres`。不要把输出中的 `DATABASE_URL` 发到
聊天、工单或提交到 SVN，其中可能包含数据库密码。

在新安装包目录执行：

```bash
CONFIG_FILE=/root/goodjob-deploy-config/deploy.conf \
  bash deploy-goodjob.sh --check-package

CONFIG_FILE=/root/goodjob-deploy-config/deploy.conf \
  bash deploy-goodjob.sh --preflight-only
```

两项都必须通过。`deploy.conf` 应保持：

```ini
REUSE_EXISTING_DATABASE=true
REPLACE_DATABASE=false
AUTO_CREATE_DATABASE=false
```

## 4. 制作可恢复备份

安装器不会自动备份业务数据。开始前必须分别备份 MySQL、旧 PostgreSQL、运行环境
和部署配置。先进入 root shell，然后执行：

```bash
BACKUP_ROOT="/root/goodjob-unified-cutover-$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "$BACKUP_ROOT"

systemctl stop goodjob-crm goodjob-crm-whatsapp

set -a
source /root/goodjob-deploy-config/deploy.conf
set +a

MYSQL_PWD="$DB_PASSWORD" /www/server/mysql/bin/mysqldump \
  --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  --single-transaction --routines --triggers --no-tablespaces \
  --set-gtid-purged=OFF --databases "$DB_NAME" \
  | gzip -c > "$BACKUP_ROOT/mysql.sql.gz"

LEGACY_DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' \
  /www/server/goodjob-crm/shared/whatsapp-plugin.env | tail -n 1)"

/www/server/pgsql/bin/pg_dump \
  --format=custom --file="$BACKUP_ROOT/communication-postgres.dump" \
  "$LEGACY_DATABASE_URL"

cp -p /www/server/goodjob-crm/shared/.env "$BACKUP_ROOT/crm.env"
cp -p /www/server/goodjob-crm/shared/whatsapp-plugin.env \
  "$BACKUP_ROOT/whatsapp-plugin.env"
cp -p /root/goodjob-deploy-config/deploy.conf "$BACKUP_ROOT/deploy.conf"

gzip -t "$BACKUP_ROOT/mysql.sql.gz"
/www/server/pgsql/bin/pg_restore --list \
  "$BACKUP_ROOT/communication-postgres.dump" >/dev/null
(cd "$BACKUP_ROOT" && sha256sum * > SHA256SUMS)
chmod -R go-rwx "$BACKUP_ROOT"
```

不要继续安装，除非 `gzip -t`、`pg_restore --list` 和 `sha256sum` 都成功。
备份失败且暂不继续排错时，执行
`systemctl start goodjob-crm goodjob-crm-whatsapp` 恢复原系统。

## 5. 执行升级和迁移

保持两个 GoodJob 服务停止，在新安装包目录执行：

```bash
CONFIG_FILE=/root/goodjob-deploy-config/deploy.conf \
  bash deploy-goodjob.sh
```

安装器会自动完成：

1. 捕获旧 `whatsapp-plugin.env` 中的 PostgreSQL URL 和原 `SESSION_MASTER_KEY`。
2. 构建并迁移 CRM 的 MySQL 结构。
3. 在同一 MySQL 库创建 Communication 表和独立迁移元数据。
4. 把 PostgreSQL 一致性快照迁入 MySQL 并逐表验证。
5. 仅在验证成功后切换生产环境、版本链接和两个 systemd 服务。
6. 完成后端、Communication、Nginx、页面和静态资源验收。

SSH 断开不会终止已用 `nohup` 启动的安装；重新登录后应查看原日志和进程，不能并发
启动第二个安装器。

## 6. 切换后验收

```bash
systemctl is-active goodjob-crm goodjob-crm-whatsapp
curl -fsS http://127.0.0.1:4188/api/health
curl -fsS http://127.0.0.1:3100/api/health/ready

grep '^DATABASE_CLIENT=mysql$' \
  /www/server/goodjob-crm/shared/whatsapp-plugin.env

CRM_URL="$(sed -n 's/^DATABASE_URL=//p' \
  /www/server/goodjob-crm/shared/.env | tail -n 1)"
COMMUNICATION_URL="$(sed -n 's/^DATABASE_URL=//p' \
  /www/server/goodjob-crm/shared/whatsapp-plugin.env | tail -n 1)"
[[ "$CRM_URL" == "$COMMUNICATION_URL" ]] \
  && echo '数据库连接一致' \
  || echo '错误：两个服务数据库连接不一致'
unset CRM_URL COMMUNICATION_URL

set -a
source /root/goodjob-deploy-config/deploy.conf
set +a
MYSQL_PWD="$DB_PASSWORD" /www/server/mysql/bin/mysql \
  --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  -N -B "$DB_NAME" -e "
    SELECT version,name FROM communication_schema_migrations ORDER BY version;
    SELECT id,completed_at FROM communication_data_migrations;
    SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema=DATABASE()
        AND table_name IN (
          'channel_accounts','integration_preferences','meta_app_configs',
          'ai_provider_profiles','contacts','meta_account_credentials',
          'provider_session_keys','conversations','messages',
          'translation_preferences','translations','routing_rules',
          'crm_contacts','media_retention_settings','audit_logs'
        );
  "
```

验收标准：两个服务均为 `active`，健康检查成功，连接串一致，结构迁移版本为
`1` 到 `5`，数据迁移标记为 `postgres-to-mysql-v1`，业务表数量为 `15`。

最后在浏览器检查：登录、Communication 账号列表、历史联系人、会话、消息、Meta
配置、翻译设置和新增一条测试消息。测试数据应在验收后按业务流程清理。

## 7. 失败和回滚边界

### 迁移标记写入前失败

MySQL 迁移事务会自动回滚，旧 PostgreSQL 未改变。安装器恢复旧环境和旧版本后，
可以继续运行旧系统；排除错误后可重新执行完整流程。

### 迁移标记写入后、正式验收前失败

安装器可能恢复旧服务。再次安装时只会重新核验已完成快照，不会覆盖 MySQL。
如果旧 PostgreSQL 在回滚期间产生新写入，源指纹会变化，重试将停止。此时不要删除
迁移标记或手工复制部分表，应重新建立维护窗口并由运维人员决定以哪一侧为权威数据。

### 成功上线并产生新业务数据后

不能直接把 Communication 切回旧 PostgreSQL，否则会形成两套分叉数据。当前没有
自动 MySQL 到 PostgreSQL 的反向迁移。需要回退时，应先停止写入，并基于切换前备份、
MySQL 当前快照和业务时间点制定恢复方案。

无论哪种情况，都不要执行以下操作：

```text
DROP DATABASE
TRUNCATE communication tables
docker compose down -v
删除旧 PostgreSQL 数据目录或数据卷
更换 SESSION_MASTER_KEY
```

## 8. 旧 PostgreSQL 的退役

切换当天只停止 GoodJob 对旧库的使用，不停止宝塔 PostgreSQL 服务，因为服务器上可能
还有其他项目。至少保留旧库和迁移前备份一个完整回滚周期。确认备份异机可恢复、业务
验收完成且回滚窗口结束后，再单独审批删除 GoodJob 的旧数据库和用户。
