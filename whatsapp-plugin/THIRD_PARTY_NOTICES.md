# Communication 第三方组件说明

本目录的业务代码集成自本机 `CRM系统对接` 工作副本。该副本没有提交记录或
远程仓库，因此无法把业务代码归给一个未确认的第三方作者。WhatsApp 协议、
加密和媒体能力仍分别归属于下表的上游项目。本服务自身使用
`GPL-3.0-only`，原因是运行时依赖链包含 GPL-3.0 的 `libsignal`。

本项目不是 Meta 官方 SDK；Baileys 通道也不是 Meta 官方 API。本实现没有复制
Evolution API 的服务端代码。

主要运行时依赖：

| 组件 | 当前版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| WhiskeySockets/Baileys | 7.0.0-rc13 | MIT | WhatsApp Web 连接、AuthState 与消息事件 |
| `libsignal` / WhiskeySockets/libsignal-node | 6.0.0 | GPL-3.0 | Baileys 使用的 Signal 加密运行时 |
| `whatsapp-rust-bridge` / João Lucas | 0.5.4 | MIT | Baileys 的运行时桥接依赖 |
| `node-webpmux` / ApeironTsuka | 3.2.1 | LGPL-3.0-or-later | `whatsapp-web.js` 的媒体传递依赖（CRM 后端） |
| `whatsapp-web.js` / Pedro Lopez | 1.34.7 | Apache-2.0 | CRM 后端的旧 Web 客户端通道 |
| Meta Graph API | 外部服务 | Meta 平台条款 | WhatsApp Cloud API 官方通道 |
| PGlite | 0.5.4 | Apache-2.0 | 本机嵌入式 PostgreSQL |
| mysql2 | 3.22.5 | MIT | 生产 MySQL 连接池、参数化查询与事务 |
| Socket.IO | 4.8.3 | MIT | 实时事件 |
| React | 18.3.1 | MIT | 插件前端 |
| TanStack Query | 5.101.2 | MIT | 前端数据同步 |
| Lucide React | 0.468.0 | ISC | 界面图标 |

完整直接与传递依赖及精确版本以 `package-lock.json` 为准。发布制品时应保留各依赖包内的
许可证文件，并按 Meta/WhatsApp 的当前平台条款另行完成账号、模板、隐私和消息合规审核。

Communication 的完整 GPL 文本位于本目录 `LICENSE`，上游 MIT、GPL 和 LGPL 文本位于
仓库根目录 `LICENSES/`。允许商业使用，但分发 Communication 时必须同时提供源代码或
符合 GPL-3.0 的源代码获取方式，并保留上游版权和许可证声明。
