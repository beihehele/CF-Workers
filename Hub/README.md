# 边缘代理工具箱 — worker.js 全量说明文档

基于 Cloudflare Worker 的单文件边缘代理服务，融合了 [CF-Workers-GitHub](https://github.com/beihehele/CF-Workers-GitHub)、[CF-Workers-Raw](https://github.com/beihehele/CF-Workers-Raw) 及自定义 API 能力。

---

## 目录

1. [服务概述](#1-服务概述)
2. [架构与路由](#2-架构与路由)
3. [接口说明](#3-接口说明)
   - [3.0 接口总览](#30-接口总览)
   - [3.3 GitHub REST API](#33-github-rest-api-path)
   - [3.10 直连加速 vs /github/ API](#310-直连加速-vs-github-api)
4. [GitHub 直连加速](#4-github-直连加速)
   - [4.1 对外 API 集成（推荐）](#41-对外-api-集成推荐)
   - [4.2 支持的 URL 类型](#42-支持的-url-类型)
   - [4.3 其他访问方式](#43-其他访问方式)
5. [鉴权与安全](#5-鉴权与安全)
6. [环境变量](#6-环境变量)
7. [部署配置](#7-部署配置)
8. [错误响应](#8-错误响应)
9. [代码内常量](#9-代码内常量)
10. [典型使用场景](#10-典型使用场景)
11. [路由速查表](#11-路由速查表)

---

## 1. 服务概述

### 1.1 能力模块

| 模块 | 路由 | 说明 |
|------|------|------|
| GitHub REST API | `/github/{path}` | 代理 `api.github.com` |
| 公开 Raw 短路径 | `/raw/{path}` | 脚本内短路径，白名单校验 |
| 私有库 Raw | `/myRaw/{path}` | 绑定私有仓库，AUTH_TOKEN 鉴权 |
| 固定 Gist | `/gist?key=` | 读取预配置 Gist |
| KV 存储 | `/storage` | KV 键值读取 |
| 网络测速 | `/speedtest?bytes=` | 下载带宽测试 |
| 健康检查 | `/health` | 存活探测 |
| GitHub 直连加速 | 根路径拼接 GitHub URL | 公开文件流式代理（见第 4 章） |

### 1.2 公开文件访问方式

| 方式 | 拼接规则 | 适用场景 |
|------|---------|---------|
| **对外 API 拼接（推荐）** | `{ORIGIN}/` + `https://github.com/...` | 外部系统直接拼接完整 GitHub 地址 |
| **无协议路径** | `{ORIGIN}/github.com/...` | 简洁 URL，效果相同 |
| **短路径 API** | `{ORIGIN}/raw/owner/repo/branch/file` | 脚本内短路径拼接 |
| **搜索框 / ?q=** | 粘贴完整 GitHub 链接 | 浏览器手动访问 |

> 对外提供加速 API 时，请将 `{ORIGIN}/` 作为基址，由调用方在其后拼接**完整 GitHub HTTPS 地址**。详见 [4.1 节](#41-对外-api-集成推荐)。

### 1.3 通用特性

- 全接口 CORS（`Access-Control-Allow-Origin: *`）
- 流式转发响应体，适合大文件
- 重定向链深度上限 5 次
- 爬虫 UA 屏蔽（返回 nginx 伪装页）
- 根路径 HTML 文档页 + GitHub 链接搜索框 + **网页测速/测延迟**
- 统一 JSON 错误格式 `{ code, message }`

---

## 2. 架构与路由

### 2.1 路由优先级

请求按以下顺序匹配，命中即返回：

```
1.  OPTIONS                         → CORS 预检
2.  屏蔽 UA                         → nginx 伪装页
3.  ?q= 参数                        → GitHub 链接跳转（须通过白名单校验）
4.  /health                         → 健康检查
5.  /github/*（排除 /github.com/*）  → GitHub REST API
6.  /gist                           → Gist 读取
7.  /storage                        → KV 存储
8.  /speedtest                      → 网络测速
9.  /raw 或 /raw/*                  → 公开 Raw 短路径
10. /myRaw 或 /myRaw/*              → 私有库 Raw
11. /                               → 首页 / URL 重定向
12. GitHub 直连路径                  → release/archive/raw/blob/gist 等
13. 未匹配                          → HOME=302: 重定向或 404
```

### 2.2 关键路由区分

| 路径 | 匹配规则 | 说明 |
|------|---------|------|
| `/github/repos/...` | `isGitHubApiRoute()` | REST API 代理 |
| `/github.com/user/...` | 直连加速 | **不会**误匹配 API 路由 |
| `/raw/user/repo/...` | `isRawApiRoute()` | 短路径 API |
| `/raw.githubusercontent.com/...` | 直连加速 | **不会**误匹配 `/raw/` API |

---

## 3. 接口说明

以下 `{ORIGIN}` 表示 Worker 部署地址，如 `https://your-worker.workers.dev`。

### 3.0 接口总览

首页 API 列表顺序：`/github` → `/raw` → `/myRaw` → `/gist` → `/storage` → `/speedtest` → `/health`。GitHub 文件加速见上方「GitHub 加速 API」卡片及第 4 章。

**选型速查：**

| 需求 | 推荐接口 |
|------|---------|
| 下载 zip / release / 公开 raw | **直连加速**（见第 4 章） |
| 脚本里用短路径拉公开文件 | `/raw/owner/repo/branch/file` |
| 拉取私有仓库配置 | `/myRaw/config.yaml` |
| Clash 等无法设 Header 的订阅 | `/myRaw/...?token=`（见 5.2 方式二） |
| 查 GitHub API 返回 JSON | `/github/repos/...` |
| 读固定 Gist | `/gist?key=filename` |
| 读 KV 中存的配置 | `/storage?filename=...` |

---

### 3.1 首页 `GET /`

返回内置 HTML 文档页，含 GitHub 加速说明、**网络测试面板**（延迟 + 下载测速）。

**网页网络测试：**

| 功能 | 说明 |
|------|------|
| 延迟测试 | 下拉选择 Worker / Google（默认）/ Cloudflare generate_204，各测 5 次 |
| 下载测速 | 调用 `/speedtest`，可选 10 / 20 / 50 MB（默认 20）；需设 `PUBLIC=speedtest` 方可在首页免鉴权使用 |

延迟目标地址：

| 选项 | URL |
|------|-----|
| Worker 节点 | `{ORIGIN}/health` |
| Google | `http://gstatic.com/generate_204`（HTTPS 页面自动用 `https://www.gstatic.com/generate_204`） |
| Cloudflare | `https://cp.cloudflare.com/generate_204` |

| 环境变量 | 行为 |
|---------|------|
| 无 | 显示文档页 |
| `HOME=nginx` | nginx 伪装页 |
| `HOME=proxy:https://...` | 反向代理到指定 URL |
| `HOME=302:https://...` | 302 重定向 |

---

### 3.2 快捷跳转 `GET /?q={github_url}`

将 GitHub 链接跳转为 Worker 加速地址。

```http
GET /?q=github.com/user/repo/archive/main.zip
→ 302 → /github.com/user/repo/archive/main.zip
```

- 仅允许 GitHub 白名单 URL，否则返回 `400`
- 首页搜索框与此逻辑相同

---

### 3.3 GitHub REST API `/github/{path}`

**鉴权：** 配置 `AUTH_TOKEN` 后需鉴权；`PUBLIC=github` 可保持公开  
**方法：** GET / POST / PUT / PATCH / DELETE / HEAD

代理转发至 `https://api.github.com/{path}`，返回 GitHub API 的 JSON 响应。URL 中的 `token` 鉴权参数**不会**转发给 GitHub。

**可选配置：** `GITHUB_TOKEN`（提升 API 限速至 5000 次/小时）

**请求示例：**

```http
GET /github/repos/owner/repo/releases/latest
Authorization: Bearer YOUR_AUTH_TOKEN

GET /github/users/octocat
Authorization: Bearer YOUR_AUTH_TOKEN

POST /github/repos/owner/repo/issues
Authorization: Bearer YOUR_AUTH_TOKEN
Content-Type: application/json

{ "title": "issue title", "body": "..." }
```

**注意：** `/github.com/user/repo/...` 是**直连加速**，不是本接口。详见 3.10 节。

---

### 3.4 公开 Raw 短路径 `GET /raw/{path}`

**鉴权：** 无  
**方法：** GET  
**限制：** GitHub URL 白名单；代码内 `WHITE_LIST`（若配置）

代理**公开仓库**文件，仅支持短路径，不支持在 `/raw/` 后写完整域名。

**支持格式：**

```http
GET /raw/owner/repo/branch/file.txt
GET /raw/owner/repo/releases/download/v1.0/app.zip
GET /raw/owner/repo/archive/main.zip
```

**与直连加速的区别：**

| 对比项 | `/raw/` 短路径 | 直连加速 |
|--------|---------------|---------|
| URL 形式 | `{ORIGIN}/raw/owner/repo/main/f` | `{ORIGIN}/github.com/...` 或完整 HTTPS |
| 完整域名 | ❌ 不支持 | ✅ 支持 |
| 适用场景 | 脚本内固定拼接 | 对外分发、完整 GitHub URL |

完整 `raw.githubusercontent.com/...` 请用直连：`{ORIGIN}/raw.githubusercontent.com/owner/repo/main/file.txt`

---

### 3.5 私有库 Raw `GET|HEAD /myRaw/{path}`

**鉴权：** `AUTH_TOKEN`（必须）；可选 `TOKEN_PATH` 路径级密钥  
**方法：** GET / HEAD

读取**绑定单一私有仓库**的文件，服务端使用 `GH_TOKEN` 向 GitHub 认证，客户端密钥永不转发。

**前置配置：**

| 变量 | 格式 | 示例 |
|------|------|------|
| `GH_REPO` | `owner/repo@branch` | `myuser/private-config@main` |
| `GH_TOKEN` | GitHub PAT（secret） | 需 `repo` 读权限 |
| `AUTH_TOKEN` | 客户端密钥 | 自行生成强随机串 |

**请求示例：**

```http
GET /myRaw/config.yaml
Authorization: Bearer YOUR_AUTH_TOKEN

GET /myRaw/sub/dir/rules.yaml
Authorization: Bearer YOUR_AUTH_TOKEN
```

**服务端实际请求 GitHub：**

```
GET https://raw.githubusercontent.com/{owner}/{repo}/{branch}/config.yaml
Authorization: Bearer {GH_TOKEN}
```

**安全限制：**

- 仅允许短路径，禁止 `/myRaw/raw.githubusercontent.com/...` 跨仓库访问
- 客户端 `AUTH_TOKEN` 只做鉴权，**不会**作为 GitHub PAT 发出
- 错误 token 返回 403，不会泄露 `GH_TOKEN`

**TOKEN_PATH 路径级鉴权（可选）：**

```
TOKEN_PATH=key1@/public,key2@/secret/config.yaml
```

| 规则 | 说明 |
|------|------|
| 格式 | `访问密钥@/路径` |
| 匹配 | 路径命中时使用该密钥鉴权（可不同于 `AUTH_TOKEN`） |
| 未匹配 | 回退到默认 `AUTH_TOKEN` |

**典型场景：** Clash / Surge 订阅拉取私有配置（无法设 Header 时可用 URL `?token=`，见 5.2 节）。

---

### 3.6 固定 Gist `GET /gist?key={filename}`

**鉴权：** `AUTH_TOKEN`（必须）  
**方法：** GET

读取环境变量 `GIST` 绑定的固定 Gist 中某个文件的原始内容。

**前置配置：**

```
GIST=user/gist_id
```

**请求：**

```http
GET /gist?key=config.yaml
Authorization: Bearer YOUR_AUTH_TOKEN
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `key` | 是 | Gist 内文件名 |

**响应：** 流式返回文件内容，保留 Gist 原始 Content-Type

> 公开 Gist 可直接用直连加速，无需本接口：`{ORIGIN}/gist.githubusercontent.com/user/id/raw/file.txt`

---

### 3.7 KV 存储 `GET /storage`

**鉴权：** `AUTH_TOKEN`（必须）  
**方法：** GET（只读）

从 Cloudflare KV（绑定名 `SUB_BUCKET`）读取已存储的键值。

**前置配置：** `SUB_BUCKET` KV 命名空间绑定 + `AUTH_TOKEN`

**请求：**

```http
GET /storage?filename=config.yaml
Authorization: Bearer YOUR_AUTH_TOKEN
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `filename` | 是 | KV 键名 |

**响应：** 保留写入时的 Content-Type，默认 `text/plain; charset=utf-8`

> 本接口仅支持读取；数据需通过 Cloudflare 控制台或其他方式写入 KV。

---

### 3.8 网络测速 `GET /speedtest?bytes={size}`

**鉴权：** 配置 `AUTH_TOKEN` 后默认需鉴权；设 `PUBLIC=speedtest` 或 `PUBLIC=1` 可公开  
**方法：** GET

代理 Cloudflare 官方测速接口，返回指定字节数的二进制流，用于带宽测试。

| 参数 | 说明 | 限制 |
|------|------|------|
| `bytes` | 下载字节数（必填） | 1 ~ 100,000,000（100MB） |

**请求示例：**

```http
# 已设 PUBLIC=speedtest 时无需鉴权
GET /speedtest?bytes=20000000

# 未设 PUBLIC 且已配置 AUTH_TOKEN 时
GET /speedtest?bytes=20000000
Authorization: Bearer YOUR_AUTH_TOKEN
```

**响应：** `Content-Type: application/octet-stream`，二进制流

**首页测速：** `wrangler.toml` 中默认 `PUBLIC = "speedtest"`，网页测速无需携带 token。

---

### 3.9 健康检查 `GET /health`

**鉴权：** 无  
**方法：** GET

用于存活探测、延迟测试（首页「Worker 节点」选项）。

**请求：**

```http
GET /health
```

**响应：**

```json
{ "status": "ok" }
```

- 不暴露环境变量、Secret 或 KV 绑定状态
- 无请求参数

---

### 3.10 直连加速 vs `/github/` API

二者路径相似但用途完全不同，切勿混用。

| 对比 | 直连加速 | `/github/{path}` |
|------|---------|-----------------|
| 示例路径 | `/github.com/user/repo/archive/main.zip` | `/github/repos/user/repo/releases/latest` |
| 代理目标 | `github.com` / `raw.githubusercontent.com` | `api.github.com` |
| 返回内容 | 文件二进制流 | JSON 数据 |
| 主要用途 | 下载加速 | 调用 GitHub API |
| 鉴权 | 公开 | 配置 `AUTH_TOKEN` 后需鉴权 |
| 写操作 | 否 | 支持 POST 等 |

**记忆口诀：** 要**文件**用直连，要**数据**用 `/github/` API。

---

## 4. GitHub 直连加速

无需 `/raw/` 等 API 前缀，在 Worker 根路径后直接拼接 GitHub 地址即可加速。

---

### 4.1 对外 API 集成（推荐）

将 Worker 部署地址作为**加速 API 基址**分发给外部调用方，由对方直接拼接完整 GitHub URL。

#### 拼接规则

```
加速地址 = WORKER_BASE + GITHUB_URL
```

| 变量 | 要求 | 示例 |
|------|------|------|
| `WORKER_BASE` | **必须以 `/` 结尾** | `https://your-worker.workers.dev/` |
| `GITHUB_URL` | 完整 GitHub 链接（推荐带 `https://`） | `https://github.com/owner/repo/archive/main.zip` |

#### 示例

```
https://your-worker.workers.dev/https://github.com/owner/repo/archive/main.zip
https://your-worker.workers.dev/https://raw.githubusercontent.com/owner/repo/main/README.md
https://your-worker.workers.dev/https://github.com/owner/repo/releases/download/v1.0/app.zip
```

等价的无协议写法（同样支持）：

```
https://your-worker.workers.dev/github.com/owner/repo/archive/main.zip
https://your-worker.workers.dev/raw.githubusercontent.com/owner/repo/main/README.md
```

#### 外部集成代码示例

**JavaScript**

```javascript
const WORKER_BASE = 'https://your-worker.workers.dev/';
const githubUrl = 'https://github.com/owner/repo/archive/main.zip';
const accelUrl = WORKER_BASE + githubUrl;
```

**Python**

```python
WORKER_BASE = 'https://your-worker.workers.dev/'
github_url = 'https://github.com/owner/repo/archive/main.zip'
accel_url = WORKER_BASE + github_url
```

**curl**

```bash
curl -L "https://your-worker.workers.dev/https://github.com/owner/repo/archive/main.zip" -o main.zip
```

**订阅/配置拉取（Clash 等）**

```yaml
url: "https://your-worker.workers.dev/https://github.com/owner/repo/raw/main/config.yaml"
```

#### 集成注意事项

| 事项 | 说明 |
|------|------|
| 基址尾部 `/` | 必须保留，否则 `https://worker.dev` + `https://github.com/...` 会拼成错误 URL |
| 完整 `https://` | **支持**；推荐外部直接拼 `https://github.com/...` |
| 不要用 `/raw/` 前缀 | 对外 API 应拼 GitHub 原地址，不是 `/raw/owner/repo/...` |
| 不要用 `/github/` 前缀 | `/github/repos/...` 是 REST API 路由，不是文件加速 |
| 公开仓库 only | 直连加速无鉴权，私有仓库请用 `/myRaw/` |
| 路径编码 | 少数客户端可能对 `://` 编码；遇问题时改用无协议形式 `github.com/...` |

#### 可复制对外说明

```text
GitHub 加速 API

基址：https://your-worker.workers.dev/

用法：将 GitHub 文件/Release/Archive 的完整 URL 拼接到基址后访问。

公式：加速地址 = 基址 + GitHub完整地址

示例：
  https://your-worker.workers.dev/https://github.com/owner/repo/archive/main.zip
  https://your-worker.workers.dev/https://raw.githubusercontent.com/owner/repo/main/README.md
  https://your-worker.workers.dev/github.com/owner/repo/releases/download/v1.0/app.zip

支持：release、archive、raw、blob、gist 等公开 GitHub 资源。
```

---

### 4.2 支持的 URL 类型

| 类型 | 示例 |
|------|------|
| Release 下载 | `github.com/user/repo/releases/download/v1.0/app.zip` |
| Archive | `github.com/user/repo/archive/main.zip` |
| Raw 文件 | `raw.githubusercontent.com/user/repo/branch/file.txt` |
| Blob（自动转 raw） | `github.com/user/repo/blob/main/file.txt` |
| Gist | `gist.githubusercontent.com/user/id/raw/file.py` |
| Tags | `github.com/user/repo/tags` |
| Git 信息 | `github.com/user/repo/info/refs` |

### 4.3 其他访问方式

#### 浏览器搜索框 / `?q=` 跳转

粘贴完整 GitHub 链接，自动去掉 `https://` 后跳转：

```http
GET /?q=https://github.com/user/repo/archive/main.zip
→ 302 → /github.com/user/repo/archive/main.zip
```

#### jsDelivr 镜像

设置 `JSDELIVR=1` 时，`blob` 路径 302 重定向到 jsDelivr CDN：

```
github.com/user/repo/blob/main/file.js
→ 302 → cdn.jsdelivr.net/gh/user/repo@main/file.js
```

#### WHITE_LIST

在代码中配置 `WHITE_LIST` 数组后，直连加速和 `/raw/` 均只允许路径包含白名单字符的请求。

---

## 5. 鉴权与安全

### 5.1 凭证职责

| 变量 | 类型 | 用途 |
|------|------|------|
| `AUTH_TOKEN` | 客户端密钥 | 所有需鉴权接口（gist、storage、myRaw、github、speedtest） |
| `GH_TOKEN` | 服务端 PAT | **仅** myRaw 向 GitHub 认证，永不暴露 |
| `GITHUB_TOKEN` | 服务端 PAT | GitHub API / 直连 / raw 限速提升（可选） |

```
客户端                          Worker                         GitHub
  │                               │                               │
  │  Bearer AUTH_TOKEN (myRaw)    │  校验 AUTH_TOKEN               │
  │ ─────────────────────────────>│  Authorization: Bearer GH_TOKEN │
  │                               │ ─────────────────────────────>│
```

**GH_TOKEN 防泄露：** 客户端密钥与 `GH_TOKEN` 完全分离；鉴权通过后 GitHub 请求固定使用 `Bearer ${GH_TOKEN}`；错误 token 直接 403。

### 5.2 鉴权方式

所有需鉴权接口均支持以下两种方式，**Header 优先**（同时提供时以 Header 为准）。首页与示例默认展示 Header 方式。

#### 方式一：请求头（推荐，首页展示）

```http
Authorization: Bearer YOUR_AUTH_TOKEN
```

- 适用于所有 HTTP 方法（GET / POST 等）
- Token 不会出现在 URL、浏览器历史、Referer 或访问日志中
- 适合脚本、curl、程序调用

**示例：**

```http
GET /myRaw/config.yaml
Authorization: Bearer YOUR_AUTH_TOKEN

GET /gist?key=file.txt
Authorization: Bearer YOUR_AUTH_TOKEN

GET /storage?filename=a.yaml
Authorization: Bearer YOUR_AUTH_TOKEN

GET /github/repos/owner/repo/releases/latest
Authorization: Bearer YOUR_AUTH_TOKEN
```

#### 方式二：URL 查询参数（备选）

无法设置请求头时使用（如 Clash / Surge 订阅 URL）：

```http
?token=YOUR_AUTH_TOKEN
```

已有查询参数时用 `&token=`：

```http
GET /myRaw/config.yaml?token=YOUR_AUTH_TOKEN
GET /gist?key=file.txt&token=YOUR_AUTH_TOKEN
GET /storage?filename=a.yaml&token=YOUR_AUTH_TOKEN
GET /speedtest?bytes=20000000&token=YOUR_AUTH_TOKEN
GET /github/repos/owner/repo/releases/latest?token=YOUR_AUTH_TOKEN
```

> URL 参数可能出现在日志和 Referer 中，除订阅拉取等场景外优先使用 Header。

#### 错误响应

| 状态码 | 场景 |
|--------|------|
| 401 | 未提供 token |
| 403 | token 无效 |

```json
{ "code": 401, "message": "请提供 AUTH_TOKEN（Header: Bearer 或 URL ?token=）" }
```

### 5.3 鉴权规则汇总

| 接口 | 鉴权要求 |
|------|---------|
| `/gist` | 始终需要 `AUTH_TOKEN` |
| `/storage` | 始终需要 `AUTH_TOKEN` |
| `/myRaw/*` | 始终需要 `AUTH_TOKEN`（或 TOKEN_PATH 规则密钥） |
| `/github/*` | 配置 `AUTH_TOKEN` 后需要；`PUBLIC` 含 `github` 可免鉴权 |
| `/speedtest` | 配置 `AUTH_TOKEN` 后需要；`PUBLIC` 含 `speedtest` 可免鉴权 |
| 直连加速 / `/raw/` | 无鉴权（公开） |
| `/health` | 无鉴权 |

### 5.4 公开接口控制

配置 `AUTH_TOKEN` 后，`/github/*` 和 `/speedtest` 默认需要鉴权。

如需保持公开：

```
PUBLIC=1                  # 全部公开
PUBLIC=github,speedtest   # 指定公开
```

---

## 6. 环境变量

### 6.1 变量详解

| 变量 | 必填 | 说明 |
|------|------|------|
| `AUTH_TOKEN` | 部分 | 客户端鉴权密钥。配置后 gist/storage/myRaw 始终需鉴权；github/speedtest 默认也需鉴权 |
| `GH_REPO` | myRaw | 私有库绑定，格式 `owner/repo@branch`，默认分支 `main` |
| `GH_TOKEN` | myRaw | 服务端 GitHub PAT，**仅** myRaw 内部使用，永不返回给客户端 |
| `GITHUB_TOKEN` | 否 | 服务端 PAT，用于 `/github/`、直连、`/raw/` 的 GitHub API 限速提升 |
| `GIST` | gist | 固定 Gist，格式 `user/gist_id` |
| `SUB_BUCKET` | storage | KV 命名空间绑定名（wrangler.toml `[[kv_namespaces]]`） |
| `TOKEN_PATH` | 否 | myRaw 路径级鉴权，`密钥@/路径`，多个逗号分隔 |
| `PUBLIC` | 否 | 公开接口白名单：`1` 全部；`github,speedtest` 指定接口 |
| `HOME` | 否 | 首页行为：`nginx` / `proxy:url` / `302:url`（裸 URL 等同 `proxy:url`） |
| `JSDELIVR` | 否 | `1` 时 blob 路径 302 到 jsDelivr CDN |
| `UA` | 否 | 额外屏蔽的 User-Agent 关键词，逗号分隔 |

### 6.2 按场景最低配置

| 场景 | 所需变量 |
|------|---------|
| 仅公开加速 | 无 |
| Gist + Storage | `AUTH_TOKEN` + `GIST` + `SUB_BUCKET` |
| 私有库 myRaw | `AUTH_TOKEN` + `GH_REPO` + `GH_TOKEN` |

### 6.3 配置示例

**仅公开 GitHub 加速：**

无需任何环境变量。

**Gist + Storage：**

```toml
[vars]
AUTH_TOKEN = "your_secret"
GIST = "your_username/your_gist_id"

[[kv_namespaces]]
binding = "SUB_BUCKET"
id = "your_kv_id"
```

**私有库 myRaw：**

```toml
[vars]
AUTH_TOKEN = "client_access_key"
GH_REPO = "your_username/your-private-repo@main"

# wrangler secret put GH_TOKEN
```

**完整配置：**

```toml
[vars]
AUTH_TOKEN = "api_secret"
GIST = "your_username/your_gist_id"
GH_REPO = "your_username/your-private-repo@main"
TOKEN_PATH = "key1@/public,key2@/secret"
PUBLIC = "github,speedtest"
HOME = "nginx"
JSDELIVR = "0"

[[kv_namespaces]]
binding = "SUB_BUCKET"
id = "your_kv_id"
```

```bash
npx wrangler secret put GH_TOKEN
npx wrangler secret put GITHUB_TOKEN
```

### 6.4 GitHub Token 权限

| Token | 所需权限 | 用途 |
|-------|---------|------|
| `GH_TOKEN` | `repo`（读私有库） | 仅 myRaw |
| `GITHUB_TOKEN` | 公开仓库只读即可 | API 限速提升 |

---

## 7. 部署配置

### 7.1 wrangler.toml 最小示例

```toml
name = "edge-proxy-toolbox"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
PUBLIC = "speedtest"   # 首页下载测速免鉴权
AUTH_TOKEN = "client_access_key"
GH_REPO = "your_username/your-private-repo@main"
```

### 7.2 部署命令

```bash
npx wrangler login
npx wrangler secret put GH_TOKEN
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy worker.js
npx wrangler dev worker.js    # 本地调试
```

---

## 8. 错误响应

### 8.1 格式

所有 API 路由统一返回 JSON：

```json
{
  "code": 403,
  "message": "AUTH_TOKEN 无效"
}
```

### 8.2 常见状态码

| 状态码 | 场景 |
|--------|------|
| 400 | 缺少参数、JSON 无效、非 GitHub 跳转链接 |
| 401 | 未提供 token（Header 或 ?token=） |
| 403 | AUTH_TOKEN 无效、白名单拒绝 |
| 404 | 路径不存在、KV 键不存在 |
| 405 | HTTP 方法不允许 |
| 500 | 环境变量未配置、服务器错误 |
| 502 | 重定向次数超过 5 次 |

---

## 9. 代码内常量

在 `worker.js` 顶部可直接修改：

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `PREFIX` | `'/'` | 路由前缀 |
| `BLOCKED_UA` | `['netcraft']` | 默认屏蔽 UA |
| `WHITE_LIST` | `[]` | 路径白名单（直连 + /raw/ 均生效） |
| `SPEEDTEST_MAX_BYTES` | `100000000` | 测速最大字节 |
| `MAX_REDIRECT_DEPTH` | `5` | 代理重定向深度上限 |

---

## 10. 典型使用场景

### 10.1 对外提供 GitHub 加速 API

将 Worker 地址作为基址分发，外部直接拼接：

```javascript
// 外部调用方
const base = 'https://worker.example.com/';
const url = base + 'https://github.com/owner/repo/releases/download/v1.0/app.zip';
fetch(url).then(r => r.blob());
```

### 10.2 私有订阅配置拉取

```yaml
proxy-providers:
  my-sub:
    type: http
    url: "https://worker.example.com/myRaw/sub.yaml?token=CLIENT_TOKEN"
    interval: 3600
```

### 10.3 GitHub Release 加速下载

```bash
curl -L "https://worker.example.com/github.com/user/app/releases/download/v1.0/app.zip" -o app.zip
```

### 10.4 远程配置读取

```bash
curl "https://worker.example.com/storage?filename=config.yaml" \
  -H "Authorization: Bearer AUTH_TOKEN"
```

### 10.5 公开脚本拉取

```bash
# 直连加速（推荐）
curl "https://worker.example.com/raw.githubusercontent.com/owner/repo/main/install.sh" | bash

# 短路径 API
curl "https://worker.example.com/raw/owner/repo/main/install.sh" | bash
```

### 10.6 节点测速

```bash
# PUBLIC=speedtest 时无需鉴权
curl "https://worker.example.com/speedtest?bytes=20000000" \
  -o /dev/null -w "%{speed_download}\n"

# 未设 PUBLIC 时需 Header 鉴权
curl "https://worker.example.com/speedtest?bytes=20000000" \
  -H "Authorization: Bearer AUTH_TOKEN" \
  -o /dev/null -w "%{speed_download}\n"
```

---

## 11. 路由速查表

与首页 API 接口列表顺序一致。

| 路由 | 方法 | 鉴权 | 服务端凭证 | 功能 |
|------|------|------|-----------|------|
| `/github/{path}` | 全部 | AUTH_TOKEN* | GITHUB_TOKEN | GitHub REST API |
| `/raw/{path}` | GET | 无 | GITHUB_TOKEN | 公开 Raw 短路径 |
| `/myRaw/{path}` | GET/HEAD | AUTH_TOKEN | GH_TOKEN | 私有库 Raw |
| `/gist?key=` | GET | AUTH_TOKEN | — | 固定 Gist |
| `/storage` | GET | AUTH_TOKEN | — | KV 读取 |
| `/speedtest?bytes=` | GET | 公开* | — | 下载测速 |
| `/health` | GET | 无 | — | 健康检查 |

**其他路由（不在 API 列表中）：**

| 路由 | 方法 | 鉴权 | 功能 |
|------|------|------|------|
| `/` | GET | 无 | 文档首页 |
| `/?q=` | GET | 无 | GitHub 链接跳转 |
| `/github.com/...` | GET | 无 | 直连加速 |
| `/raw.githubusercontent.com/...` | GET | 无 | 直连 Raw |

> \* 配置 `AUTH_TOKEN` 后 `/github/` 默认需鉴权；`/speedtest` 需 `PUBLIC=speedtest` 或 `PUBLIC=1` 保持公开（`wrangler.toml` 已默认配置）。

---

*文档版本与当前 worker.js 同步，涵盖安全加固后的全量功能。*
