# GoodJob CRM 1.7.2 安装与更新说明

## 真实物流查询

发货管理中的「真实查询」会由 backend 调用 17TRACK API，返回承运商实际提供的最新扫描位置和轨迹。物流服务通常不会返回收货人的精确门牌地址，界面中的「收货地址」仍来自 CRM 发货单或关联单据，不能把两者混为一谈。

首次配置时可填写 17TRACK API Token；如果暂时留空，应用仍可安装，但点击真实查询时会提示未配置 Token：

```text
17TRACK API Token（可留空，之后可补配）
```

申请 Token 后，在服务器执行以下命令写入受限运行密钥，再重启 backend：

```bash
read -r -s TRACKING_TOKEN
printf '\\n'
printf 'TRACKING_PROVIDER=17track\\nTRACKING_17TRACK_TOKEN=%s\\n' "$TRACKING_TOKEN" >> /opt/goodjobcrm/shared/secrets/crm_runtime_env
unset TRACKING_TOKEN
chmod 0640 /opt/goodjobcrm/shared/secrets/crm_runtime_env
cd /root/GoodJob-CRM-Registry-1.7.2
./manage.sh restart
```

不要把 Token 写入前端、Compose 文件、公开仓库或聊天记录。

这是 GoodJob CRM 的最小 Docker 部署包。安装包只包含部署脚本和 Compose 配置，服务器会从公开 ACR 仓库拉取三个镜像，不包含源码、数据库备份或业务数据。

## 1. 固定信息

```text
版本：1.7.2
前端域名：https://crm.nanmianyun.com
宿主机内部入口：http://127.0.0.1:4188
项目名：goodjobcrm
数据目录：/opt/goodjobcrm/shared
```

公开镜像：

```text
crpi-f1g4pi9vyexdaer5.cn-hongkong.personal.cr.aliyuncs.com/kevin_goodjobcrm/backend:1.7.2
crpi-f1g4pi9vyexdaer5.cn-hongkong.personal.cr.aliyuncs.com/kevin_goodjobcrm/communication:1.7.2
crpi-f1g4pi9vyexdaer5.cn-hongkong.personal.cr.aliyuncs.com/kevin_goodjobcrm/gateway:1.7.2
```

仓库是公开的，服务器端**不需要执行 `docker login`**。

首次全新安装会创建 1 个超级管理员和 50 个团队管理员：

```text
超级管理员：使用 ./configure.sh 时填写的邮箱和密码
50 个团队管理员凭据：/opt/goodjobcrm/shared/secrets/admin_credentials.tsv
```

50 个团队管理员账号为 `beta-admin-01@goodjob-crm.com` 到 `beta-admin-50@goodjob-crm.com`，分别对应 `beta-001` 到 `beta-050` 团队。密码由服务器首次配置时随机生成，不写入镜像、SVN 或部署包。首次登录后立即修改密码；已有数据库更新时，脚本只会补齐缺失账号，不会覆盖已有密码。

## 2. 安装前检查

服务器建议准备：

- Linux x86_64；
- Docker Engine 和 Docker Compose v2；
- 至少 10 GiB 可用磁盘；
- 至少 2 GiB 可用内存，低内存测试环境必须使用下方的低内存开关；
- 域名 `crm.nanmianyun.com` 的 DNS A 记录指向服务器公网 IP；
- 宝塔中已创建 `crm.nanmianyun.com` 网站，并已准备该域名证书；
- 防火墙允许 80/tcp、443/tcp。不要对公网开放 3306、3100、4188。

查看已有资源：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker network ls
docker volume ls
ss -lntp
free -h
df -h
```

## 3. 上传安装包

本机执行上传（在存放安装包的目录下执行），不能在服务器终端执行本机路径：

```bash
scp \
  "dist-packages/GoodJob-CRM-Registry-1.7.2.tar.gz" \
  "dist-packages/GoodJob-CRM-Registry-1.7.2.tar.gz.sha256" \
  root@服务器公网IP:/root/
```

服务器上校验并解压：

```bash
cd /root
sha256sum -c GoodJob-CRM-Registry-1.7.2.tar.gz.sha256
tar -xzf GoodJob-CRM-Registry-1.7.2.tar.gz
cd GoodJob-CRM-Registry-1.7.2
chmod +x *.sh
```

校验必须显示：

```text
GoodJob-CRM-Registry-1.7.2.tar.gz: OK
```

## 4. 首次配置

```bash
./configure.sh
```

按提示填写：

```text
GoodJob 专属域名：crm.nanmianyun.com
当前是否已经启用 HTTPS：y
首次超级管理员邮箱：admin@goodjob.com
首次超级管理员姓名：GoodJob Admin
首次超级管理员密码：设置一个至少 12 位的强密码
```

密码输入时终端不会回显。配置脚本会在服务器本地生成数据库密码、JWT 密钥和其他运行密钥，保存到：

```text
/opt/goodjobcrm/shared/secrets
```

不要复制、上传或公开这个目录。当前版本默认 MySQL 容器内存上限为 `768m`。

## 5. 预检与首次启动

先执行预检：

```bash
./preflight.sh
```

如果只提示可用内存低于 2 GiB，但确认服务器允许继续，必须在同一个终端会话执行：

```bash
export GOODJOB_ALLOW_LOW_MEMORY=true
./preflight.sh
```

预检通过后启动：

```bash
./install.sh
```

安装脚本会拉取三个 `1.7.2` 镜像、创建 GoodJob 专属网络和数据卷、启动 MySQL 8.4、执行幂等迁移、创建首次超级管理员和 50 个团队管理员、启动三个应用容器并检查健康状态。

查看状态：

```bash
./manage.sh status
docker ps --filter name=goodjobcrm \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

内部健康检查：

```bash
curl -fsS http://127.0.0.1:4188/api/health
```

正常结果包含：

```json
{"ok":true,"store":"mysql"}
```

## 6. 宝塔 Nginx 反向代理

只修改 `crm.nanmianyun.com` 这个 GoodJob 专属网站，不要修改其他网站、全局 Nginx 配置或其他项目的 server 块。

先找到实际配置文件：

```bash
grep -RnlE '^[[:space:]]*server_name[[:space:]]+crm\.nanmianyun\.com([[:space:]]|;)' \
  /www/server/panel/vhost/nginx 2>/dev/null
```

确认文件内容中的 `server_name` 是：

```nginx
server_name crm.nanmianyun.com;
```

编辑该网站的 HTTPS `server { ... }` 配置，在其中加入下面两个 location。`^~ /assets/` 必须保留，用于绕过宝塔旧的 JS/CSS 正则规则：

```nginx
location ^~ /assets/ {
    proxy_pass http://127.0.0.1:4188;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}

location / {
    proxy_pass http://127.0.0.1:4188;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

如果配置中已经存在 `location /`，不要增加第二个同名块，应将原 `location /` 内容替换为上面的版本。原网站的 SSL、证书、日志、`.well-known` 和其他域名配置不要改动。

修改前备份，检查通过后再重载：

```bash
cp -a /www/server/panel/vhost/nginx/实际配置文件 \
  /root/crm.nanmianyun.com.conf.bak.$(date +%Y%m%d%H%M%S)

nginx -t && systemctl reload nginx
```

若服务器的 Nginx 命令不在 PATH，使用：

```bash
/www/server/nginx/sbin/nginx -t && systemctl reload nginx
```

`nginx -t` 失败时不要 reload，先恢复刚才的站点配置备份。

## 7. 上线验收

先绕过公网 DNS 检查 Nginx 的域名匹配：

```bash
curl -I http://127.0.0.1 -H 'Host: crm.nanmianyun.com'
curl -kI https://127.0.0.1 -H 'Host: crm.nanmianyun.com'
```

检查 API 反代：

```bash
curl -kfsS https://127.0.0.1/api/health \
  -H 'Host: crm.nanmianyun.com'
```

检查前端 JS 资源，必须返回 `200`：

```bash
curl -kI https://127.0.0.1/assets/index-CA-XoN24.js \
  -H 'Host: crm.nanmianyun.com'
```

最后打开：

```text
https://crm.nanmianyun.com
```

超级管理员登录：

```text
使用 `./configure.sh` 中填写的邮箱和密码

50 个团队管理员的账号密码：

```bash
column -t -s $'\t' /opt/goodjobcrm/shared/secrets/admin_credentials.tsv
```
```

如果浏览器仍显示旧页面，Mac 使用 `Command + Shift + R`，Windows 使用 `Ctrl + F5`。

## 8. 日常管理

```bash
cd /root/GoodJob-CRM-Registry-1.7.2
./manage.sh status
./manage.sh logs 200
./manage.sh restart
./manage.sh stop
./manage.sh start
```

`stop` 只停止 GoodJob 容器，不会停止其他项目。不要执行：

```bash
docker compose down -v
```

`-v` 会删除 GoodJob 数据卷。

## 9. 备份与更新

手动备份：

```bash
./backup.sh
```

备份目录：

```text
/opt/goodjobcrm/shared/backups
```

以后发布新业务版本时，可以直接通过宝塔计划任务更新，不必再次上传最小部署包。

首次安装成功后，`install.sh` 会自动创建：

```text
/opt/goodjobcrm/ops/baota-update.sh
/opt/goodjobcrm/ops/runtime/
```

如果当前服务器是在加入此入口前安装的 1.7.2，先在当前部署包目录执行一次：

```bash
install -d -m 0700 /opt/goodjobcrm/ops /opt/goodjobcrm/ops/runtime
cp -a ./deploy/docker-compose/. /opt/goodjobcrm/ops/runtime/
chmod +x /opt/goodjobcrm/ops/runtime/*.sh
install -m 0700 ./baota-update.sh /opt/goodjobcrm/ops/baota-update.sh
```

在宝塔“计划任务”中添加 Shell 脚本任务，任务类型选择“Shell 脚本”，脚本内容填写：

```bash
/opt/goodjobcrm/ops/baota-update.sh 1.7.3 >> /opt/goodjobcrm/shared/baota-update.log 2>&1
```

执行用户选择 `root`，周期选择“手动执行”或按你的发布节奏设置。以后更新只需要：

1. 在电脑发布三个新镜像；
2. 把计划任务脚本中的版本号改成新版本，例如 `1.7.3`；
3. 点击计划任务的“执行”；
4. 在计划任务日志或 `/opt/goodjobcrm/shared/baota-update.log` 查看结果。

入口会直接调用现有更新流程，拉取对应版本的公开镜像。它会备份 MySQL、上传文件和
Communication 媒体，执行迁移、健康检查和应用回退；不会执行 `docker compose down -v`，
也不会删除 GoodJob 数据卷。服务器端不需要 `docker login`。

仍可使用命令行方式排查或手动更新：

```bash
cd /root/GoodJob-CRM-Registry-新版本目录
export GOODJOB_ALLOW_LOW_MEMORY=true
./update-registry.sh 新版本号
```

例如更新到 `1.7.3`：

```bash
cd /root/GoodJob-CRM-Registry-1.7.3
./update-registry.sh 1.7.3
```

更新脚本会拉取三个新镜像、先备份 MySQL、执行数据库迁移并启动新容器。数据保存在 MySQL Docker 卷和 `/opt/goodjobcrm/shared`，正常更新不会删除业务数据。

如果之前手动调整过 MySQL 内存，更新前确认：

```bash
grep '^MYSQL_MEMORY_LIMIT=' /opt/goodjobcrm/shared/deploy.env
```

应为：

```text
MYSQL_MEMORY_LIMIT=768m
```

应用镜像回滚：

```bash
./rollback.sh
```

数据库恢复属于破坏性操作，只能在确认备份和恢复点后执行：

```bash
./restore.sh /opt/goodjobcrm/shared/backups/具体时间戳
```

## 10. 常见问题

### 预检提示内存不足

确认 MySQL 当前限制：

```bash
docker stats --no-stream goodjobcrm-mysql-1
```

测试环境继续安装：

```bash
export GOODJOB_ALLOW_LOW_MEMORY=true
./install.sh
```

如果 MySQL unhealthy，先检查：

```bash
docker inspect goodjobcrm-mysql-1 \
  --format 'status={{.State.Status}} health={{.State.Health.Status}} oom={{.State.OOMKilled}}'
docker logs --tail 100 goodjobcrm-mysql-1
```

### 前端 JS 返回 404

直连 Gateway：

```bash
curl -I http://127.0.0.1:4188/assets/index-CA-XoN24.js
```

如果直连是 `200`、域名访问是 `404`，说明宝塔旧的 JS/CSS location 抢先匹配，检查第 6 节的 `location ^~ /assets/`。

### 登录提示账号或密码错误

`INITIAL_ADMIN_EMAIL` 和初始密码只对空数据库首次初始化生效，50 个团队管理员凭据只在服务器首次配置时生成并保存。更新镜像不会覆盖已有用户或密码。不要删除数据卷；先检查 `/opt/goodjobcrm/shared/secrets/admin_credentials.tsv`，再使用已知管理员修改密码。

### 4188 无法从公网访问

这是设计行为。4188 只监听 `127.0.0.1`，公网访问必须经过宝塔 Nginx 的 80/443 反向代理。

### 安装包需要登录 ACR 吗

不需要。本版本使用公开镜像，直接执行 `./install.sh` 或 `./update-registry.sh 1.7.2` 即可拉取。
