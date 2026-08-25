# GoodJob CRM 镜像源配置指南

本文档教你如何使用 Gitee Release 搭建 CRM 的热更新镜像源。

**核心架构：两个仓库**

| 仓库 | 可见性 | 内容 | 用途 |
|------|--------|------|------|
| `goodjob-crm` | **私有** | .ts 源码 | 开发用，别人看不到 |
| `goodjob-crm-releases` | **公开** | manifest.json + Release 附件 | 朋友下载更新用 |

源码在私有仓库里安全保护，更新包在公开仓库的 Release 里供朋友下载。

---

## 一、为什么用 Release 而不是 Raw 文件？

| 对比 | Release 附件 | Raw 文件提交到仓库 |
|------|-------------|-------------------|
| 仓库体积 | ✅ 不影响（附件不进 git） | ❌ 每次更新都撑大仓库 |
| 适合二进制 zip | ✅ 最佳 | ⚠️ 不推荐 |
| 下载速度 | ⚡ 快 | ⚡ 快 |
| 版本管理 | ✅ Tag 绑定，清晰 | ❌ 手动目录 |
| 文件大小限制 | 100MB/附件 | 100MB/文件 |

**但 manifest.json 必须用 Raw 方式**（提交到仓库根目录），因为 CRM 更新程序需要通过固定 URL 直接 fetch 到它。

---

## 二、创建 releases 仓库（3 分钟）

### 步骤 1：在 Gitee 新建公开仓库

1. 打开 https://gitee.com 并登录
2. 右上角 **`+`** → **「新建仓库」**
3. 填写信息：
   - 仓库名称：`goodjob-crm-releases`
   - 可见性：**选「开源」**（朋友需要无需认证就能下载）
   - 初始化仓库：✅ 勾选「使用 Readme 文件初始化这个仓库」
4. 点击 **「创建」**

### 步骤 2：记住你的镜像源 URL

仓库创建后，你的 Raw 文件 URL 格式是：

```
https://gitee.com/你的用户名/goodjob-crm-releases/raw/main/
```

例如：`https://gitee.com/zhangsan/goodjob-crm-releases/raw/main/`

**这个 URL 就是镜像源地址**，CRM 会自动从 `{镜像源}/manifest.json` 获取版本信息。

### 步骤 3：确保源码仓库是私有的

你的 `goodjob-crm` 源码仓库必须设为**私有**：
- Gitee → 进入源码仓库 → 管理 → 基本设置 → 是否开源 → **改为私有**

---

## 三、制作更新包

在项目根目录执行：

```bash
./scripts/packaging/make-update.sh 1.0.1 你的用户名
```

脚本会自动完成：
1. 构建前端 → 打包 `frontend.zip`
2. 编译后端 → 打包 `backend.zip`
3. 计算 SHA256 哈希
4. 生成 `manifest.json`（URL 已指向 Release 下载链接）

产物在 `dist-packages/updates/v1.0.1/` 目录下。

---

## 四、上传到 Gitee Release（2 分钟）

### Step 1：创建 Release

1. 打开 `goodjob-crm-releases` 仓库页面
2. 点击 **「管理」** → **「发布新版本」**（或仓库页面的「Releases」标签）
3. 填写：
   - Tag：`v1.0.1`（必须与版本号对应，前面加 `v`）
   - 标题：`v1.0.1`
   - 描述：更新说明（可选）
4. 在 **「附件」** 区域上传：
   - `frontend.zip`
   - `backend.zip`
   - `migrate.zip`（如有数据库迁移）
5. 点击 **「发布版本」**

### Step 2：提交 manifest.json

```bash
# 克隆 releases 仓库
git clone https://gitee.com/你的用户名/goodjob-crm-releases.git
cd goodjob-crm-releases

# 复制 manifest.json（从打包产物中）
cp /path/to/dist-packages/updates/v1.0.1/manifest.json ./manifest.json

# 编辑 changelog 字段为实际更新说明
vim manifest.json

# 提交并推送
git add manifest.json
git commit -m "发布 v1.0.1"
git push origin main
```

> **注意**：manifest.json 放在仓库根目录，通过 raw URL 访问。
> zip 包放在 Release 附件里，通过 release download URL 下载。

---

## 五、manifest.json 结构说明

```json
{
  "latestVersion": "1.0.1",
  "minimumVersion": "0.1.0",
  "releases": {
    "1.0.1": {
      "date": "2026-08-01",
      "frontend": {
        "url": "https://gitee.com/用户名/goodjob-crm-releases/releases/download/v1.0.1/frontend.zip",
        "size": 3145728,
        "sha256": "a1b2c3d4..."
      },
      "backend": {
        "url": "https://gitee.com/用户名/goodjob-crm-releases/releases/download/v1.0.1/backend.zip",
        "size": 18874368,
        "sha256": "e5f6g7h8..."
      },
      "changelog": "修复报价单导出 · 新增报关资料模板 · 优化单证多语言支持",
      "credits": "可选，鸣谢 HTML 内容"
    }
  }
}
```

### URL 规则

| 文件 | 位置 | URL 格式 |
|------|------|---------|
| manifest.json | 仓库根目录 | `https://gitee.com/{用户}/{仓库}/raw/main/manifest.json` |
| frontend.zip | Release 附件 | `https://gitee.com/{用户}/{仓库}/releases/download/v{版本}/frontend.zip` |
| backend.zip | Release 附件 | `https://gitee.com/{用户}/{仓库}/releases/download/v{版本}/backend.zip` |

### 如何计算 SHA256？

**Mac：**
```bash
shasum -a 256 frontend.zip
```

**Windows (PowerShell)：**
```powershell
Get-FileHash frontend.zip -Algorithm SHA256
```

> `make-update.sh` 脚本会自动计算并填入，无需手动操作。

---

## 六、在 CRM 中配置镜像源

1. 打开 CRM → **系统设置** 页面
2. 滚动到底部 **「系统更新」** 区域
3. 在 **「镜像源配置」** 输入框中填入：

```
https://gitee.com/你的用户名/goodjob-crm-releases/raw/main/
```

> ⚠️ URL 必须以 `/` 结尾

4. 点击 **「保存」**
5. 点击 **「检查更新」** → 如果有新版本，会显示更新内容
6. 点击 **「立即更新」** → 弹出鸣谢说明 → 确认后自动下载更新并重启

---

## 七、发布新版本的完整流程

每次你有更新要推送给朋友们时：

```
1. 修改代码 → 提交到私有源码仓库

2. 打包更新包:
   ./scripts/packaging/make-update.sh 1.0.2 你的用户名

3. 在 Gitee releases 仓库创建新 Release:
   - Tag: v1.0.2
   - 上传 frontend.zip + backend.zip 作为附件

4. 更新 manifest.json:
   cd goodjob-crm-releases
   cp ../dist-packages/updates/v1.0.2/manifest.json ./manifest.json
   # 编辑 changelog 字段
   git add . && git commit -m "发布 v1.0.2" && git push

5. 完成！朋友打开 CRM → 检查更新 → 立即更新
```

---

## 八、只更新前端（可选）

在 manifest.json 中只提供 `frontend` 字段，不提供 `backend` 字段：

```json
{
  "latestVersion": "1.0.2",
  "releases": {
    "1.0.2": {
      "date": "2026-08-01",
      "frontend": {
        "url": "https://gitee.com/.../releases/download/v1.0.2/frontend.zip",
        "size": 3145728,
        "sha256": "..."
      },
      "changelog": "UI 优化"
    }
  }
}
```

---

## 九、数据库迁移（可选）

在 manifest.json 中添加 `migrate` 字段，打包 `migrate.zip`（内含 `.sql` 文件）一起上传到 Release：

```json
{
  "1.0.2": {
    "migrate": {
      "url": "https://gitee.com/.../releases/download/v1.0.2/migrate.zip",
      "size": 1024,
      "sha256": "..."
    }
  }
}
```

更新时会自动用 mysql 客户端执行 SQL 文件。

---

## 十、常见问题

### Q1：更新失败怎么办？

CRM 更新模块有自动回滚机制——如果更新失败，会自动恢复到之前的版本。日志在：
- Mac: `~/.goodjob-crm/logs/backend.log`
- Windows: `%USERPROFILE%\.goodjob-crm\logs\backend.log`

### Q2：朋友不会配置镜像源怎么办？

在打包时预设镜像源 URL，在 `update-config.json` 中配置：
```json
{
  "mirrorUrl": "https://gitee.com/你的用户名/goodjob-crm-releases/raw/main/",
  "currentVersion": "0.1.0"
}
```

### Q3：Release 下载 URL 打不开？

检查以下几点：
1. releases 仓库必须是**公开**的
2. Tag 名称必须与 URL 中的 `v{版本}` 一致
3. 附件文件名必须与 URL 中的文件名一致（`frontend.zip` / `backend.zip`）

### Q4：源码安全吗？

- **源码仓库（goodjob-crm）**：私有，只有你能看到
- **发布仓库（goodjob-crm-releases）**：公开，但只有编译后的 zip 包和 manifest.json
- zip 包内是编译+混淆后的 JS，不含 .ts 源码
- SHA256 校验确保传输过程中不被篡改

---

## 十一、安全说明

1. **源码保护**：源码在私有仓库，发布仓库只有编译混淆后的 zip
2. **完整性校验**：每个更新包都有 SHA256 哈希校验
3. **自动回滚**：更新失败自动恢复到之前的版本，不会变砖
4. **权限控制**：只有管理员和超级管理员可以执行更新操作
