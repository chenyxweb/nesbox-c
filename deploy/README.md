# NESBox 私有化部署指南

本文档指导你在 NAS 或任意 Linux 服务器上通过 Docker Compose 私有化部署 NESBox 在线多人游戏平台。

## 目录

- [架构概览](#架构概览)
- [前置要求](#前置要求)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [游戏数据本地化](#游戏数据本地化)
- [增量更新游戏](#增量更新游戏)
- [HTTPS 配置 (lucky 反向代理)](#https-配置-lucky-反向代理)
- [日常维护](#日常维护)
- [备份与恢复](#备份与恢复)
- [升级指南](#升级指南)
- [故障排查](#故障排查)

---

## 架构概览

```
                    ┌─────────────────────────────────────────┐
                    │              NAS / 服务器                │
                    │                                         │
  用户浏览器 ──────►│  ┌─────────┐    ┌─────────┐    ┌─────┐ │
  (HTTP/HTTPS)      │  │ webapp  │───►│ server  │───►│ pg  │ │
                    │  │ (nginx) │    │ (Rust)  │    │     │ │
                    │  └────┬────┘    └─────────┘    └─────┘ │
                    │       │                                 │
                    │       ▼                                 │
                    │  ┌─────────┐                           │
                    │  │  data/  │  ← 本地化游戏资源          │
                    │  │ (挂载)  │    (ROM/预览图/截图)        │
                    │  └─────────┘                           │
                    └─────────────────────────────────────────┘
                              ▲
                              │ (可选) lucky / caddy 反向代理
                              │ 提供 HTTPS + 域名
```

**服务组成：**

| 服务 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| `postgres` | `postgres:16-alpine` | 内部 5432 | 数据库，存储用户/游戏/房间数据 |
| `server` | 自建 (Rust) | 内部 8080 | GraphQL API + WebSocket 订阅 |
| `webapp` | 自建 (nginx) | **对外 ${WEBAPP_PORT}** | 前端 SPA + API 反向代理 + 静态资源 |

**数据流：**
1. 浏览器访问 `http://<nas-ip>:8080` → nginx 返回前端 SPA
2. 前端调用 `/api/graphql` → nginx 反代到 `server:8080/graphql`
3. 前端加载游戏 ROM `/files/roms/xxx.zip` → nginx 直接返回本地文件
4. WebSocket 订阅 `/api/subscriptions` → nginx 反代到 `server:8080/subscriptions`

---

## 前置要求

### 硬件

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2 GB | 4 GB+ |
| 磁盘 | 10 GB | 20 GB+ SSD |
| 网络 | 100 Mbps | 1 Gbps |

> **磁盘空间说明：** 游戏资源约 2-5 GB（取决于游戏数量），PostgreSQL 数据约 100 MB，Docker 镜像约 1 GB。

### 软件

- **Docker** 20.10+ 与 **Docker Compose** v2+
- **Node.js** 18+（仅本地化脚本需要，可在其他机器运行）
- **Git**（拉取代码）

### 检查 Docker 环境

```bash
docker --version          # Docker version 20.10+
docker compose version    # Docker Compose version v2+
```

---

## 快速开始

### 1. 克隆项目

```bash
git clone --recurse-submodules https://github.com/mantou132/nesbox.git
cd nesbox
```

> 如果已克隆，确保子模块已初始化：`git submodule update --init --recursive`

### 2. 配置环境变量

```bash
cd deploy
cp .env.example .env
```

编辑 `.env`，**必须修改**以下两项：

```bash
# 生成强密码
openssl rand -base64 24  # 用于 POSTGRES_PASSWORD
openssl rand -hex 32     # 用于 SECRET
```

```env
POSTGRES_PASSWORD=<你的强密码>
SECRET=<你的JWT密钥>
```

### 3. 本地化游戏数据

```bash
# 回到项目根目录
cd ..

# 运行完整本地化（下载所有游戏资源，约 2-5 GB）
node deploy/scripts/localize-games.mjs
```

> 此步骤需要较长时间（取决于网络），可中断后重新运行（已下载的会跳过）。

### 4. 本地构建镜像并部署到服务器

> **架构说明：** 本地为 ARM (Apple Silicon)，服务器为 x86 (amd64)。
> `docker-compose.yml` 已将 `server` / `webapp` 固定为 `platform: linux/amd64`，
> 因此在 ARM 本地构建出的镜像可直接在 x86 服务器运行。
>
> 第 1-3 步（克隆、`.env`、本地化）在**服务器**上完成，本节仅在本地构建镜像并传输过去。

#### 4.1 本地交叉构建 amd64 镜像

```bash
# 本地 ARM 机器，需先克隆仓库
cd deploy

# ARM 上通过 buildx + QEMU 模拟编译 amd64（Docker Desktop 默认已内置 QEMU）
docker compose build              # 构建全部（server + webapp）
docker compose build server       # 只构建后端（改了 Rust 代码时）
docker compose build webapp       # 只构建前端（改了前端源码 / 构建参数时）
```

首次构建耗时较长：原生约 10-20 分钟，ARM 模拟 amd64 编译 Rust 会更慢（约 30-60 分钟）。

> 若提示缺少 QEMU 模拟器，可执行：
> `docker run --privileged --rm tonistiigi/binfmt --install amd64`

#### 4.2 导出镜像为 tar

```bash
# 全部（server + webapp）
docker save -o nesbox-images.tar nesbox/server:local nesbox/webapp:local

# 只更新一个镜像时，单独导出即可
docker save -o nesbox-server.tar nesbox/server:local   # 仅后端
docker save -o nesbox-webapp.tar nesbox/webapp:local   # 仅前端
```

#### 4.3 传输文件到服务器

本地化产物（`data/`、`postgres/init/02-games.sql`）也在本地生成，因此除了镜像 tar，运行时资源要一并传到服务器的 `deploy/` 目录（共约 200 MB）。

**需要复制（放到服务器 `deploy/` 下）：**

| 文件 / 目录 | 作用 |
|------|------|
| `docker-compose.yml` | 编排文件（含 `platform: linux/amd64`） |
| `.env` | 密码 / 密钥 / 端口 |
| `postgres/init/*.sql` | 建表脚本 + 本地化游戏数据 |
| `data/{roms,previews,screenshots,description}/` | 本地化游戏资源（ROM / 预览图 / 截图，约 124 MB） |
| `nesbox-images.tar` | server + webapp 镜像（约 76 MB） |

**无需复制（仅本地构建 / 本地化时用）：** `server/`、`webapp/`（Dockerfile、nginx.conf 已打进镜像）、`scripts/`、`README.md`、`.env.example`、仓库源码（`packages/`、`games/` 等）、`data/.url-cache.json`、`data/.failed-downloads.json`、`.DS_Store`。

在 `deploy/` 目录（即 4.2 生成 tar 的位置）执行，一条 rsync 精准同步并自动排除无关文件：

```bash
rsync -avz --progress \
  --exclude '.DS_Store' \
  --exclude 'server/' \
  --exclude 'webapp/' \
  --exclude 'scripts/' \
  --exclude 'README.md' \
  --exclude '.env.example' \
  --exclude 'data/.url-cache.json' \
  --exclude 'data/.failed-downloads.json' \
  ./ <user>@<server-ip>:/path/to/nesbox/deploy/
```

把 `<user>@<server-ip>:/path/to/nesbox/deploy/` 换成真实值（如群晖 `admin@192.168.x.x:/volume1/docker/nesbox/deploy/`）。

没有 rsync 时可改用 scp（需自行避开上面「无需复制」的文件）：

```bash
scp nesbox-images.tar docker-compose.yml .env <user>@<server-ip>:/path/to/nesbox/deploy/
scp -r data postgres <user>@<server-ip>:/path/to/nesbox/deploy/
```

> **只更新单个镜像时**：资源文件（`data/`、`postgres/`）未变，只需传对应 tar，无需重跑整条 rsync：
> `scp nesbox-server.tar <user>@<server-ip>:/path/to/nesbox/deploy/`（或 `nesbox-webapp.tar`）。

#### 4.4 服务器加载镜像并启动

```bash
# SSH 登录服务器
ssh <user>@<server-ip>
cd /path/to/nesbox/deploy

# 加载本地构建的 amd64 镜像
docker load -i nesbox-images.tar

# 启动（不要加 --build，直接复用已加载的镜像）
docker compose up -d
```

只更新单个镜像时，加载对应 tar 后单独重启该服务即可（不影响其他容器）：

```bash
docker load -i nesbox-server.tar && docker compose up -d server   # 仅后端
docker load -i nesbox-webapp.tar && docker compose up -d webapp   # 仅前端
```

> `postgres:16-alpine` 是多架构公共镜像，服务器首次启动会自动拉取 amd64 版本（需联网）。
> 若服务器无外网，可在本地执行
> `docker pull --platform linux/amd64 postgres:16-alpine && docker save -o postgres.tar postgres:16-alpine`，
> 一并传输后在服务器 `docker load -i postgres.tar`。

### 5. 验证部署

```bash
# 检查容器状态
docker compose ps

# 查看日志
docker compose logs -f server
docker compose logs -f webapp

# 测试访问
curl http://localhost:8080/healthz    # 应返回 "ok"
curl http://localhost:8080/api/playground  # GraphQL Playground
```

浏览器访问 `http://<nas-ip>:8080`，应看到 NESBox 首页。

### 6. 注册首个用户

打开浏览器 → 点击"注册" → 创建账号 → 开始游戏！

---

## 配置说明

### 环境变量详解

所有配置项见 [`.env.example`](.env.example)，关键项：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `POSTGRES_PASSWORD` | ✅ | - | 数据库密码 |
| `SECRET` | ✅ | - | JWT 签名密钥，修改后所有用户需重新登录 |
| `POSTGRES_USER` | ❌ | `nesbox` | 数据库用户名 |
| `POSTGRES_DB` | ❌ | `nesbox` | 数据库名 |
| `WEBAPP_PORT` | ❌ | `8080` | 对外 HTTP 端口 |
| `API_BASE` | ❌ | `/api` | 前端 API 基路径 |
| `CORS_ORIGIN` | ❌ | `off` | 外部资源代理：`off` 禁用（使用本地资源），留空使用官方代理，或指定自定义域名 |
| `AI_SEARCH_BASE` | ❌ | (空) | AI 搜索服务，留空禁用 |
| `AI_COMPLETIONS_BASE` | ❌ | (空) | AI 问答服务，留空禁用 |
| `GAMES_SYNC_URL` | ❌ | `off` | 游戏数据同步 URL，`off` 禁用 |
| `RUST_LOG` | ❌ | `info` | 后端日志级别 |

### 修改端口

如果 8080 已被占用：

```env
WEBAPP_PORT=3000
```

```bash
docker compose up -d
```

访问 `http://<nas-ip>:3000`。

### 启用 AI 搜索（可选）

如果你有自建的 AI 搜索服务（兼容 Cloudflare Worker API）：

```env
AI_SEARCH_BASE=https://your-ai-service.example.com
AI_COMPLETIONS_BASE=https://your-ai-service.example.com
```

重新构建前端：

```bash
docker compose build webapp
docker compose up -d webapp
```

---

## 游戏数据本地化

### 本地化原理

官方 NESBox 的游戏资源（ROM、预览图、截图）托管在 GitHub / CDN，前端通过 `files.xianqiao.wang` CORS 代理访问。

私有化部署时，本地化脚本会：
1. 从官方 API 获取游戏数据（164 条游戏，实时同步）
2. 解析其中的远程 URL
3. 并发下载所有资源到 `deploy/data/`
4. 生成新的 SQL，将 URL 替换为 `/files/...` 相对路径
5. PostgreSQL 首次启动时自动执行此 SQL

### 数据源

脚本从 **官方 NESBox API** 获取游戏数据：

- **API 端点**: `https://api.xianqiao.wang/nesbox/guestgraphql`
- **游戏数量**: 164 条（实时同步官方数据库）
- **认证**: 无需认证（guestgraphql 是公开端点）

可通过 `NESBOX_API_URL` 环境变量指向备用 API（如官方 API 不可用时）。

### 本地化后的资源结构

```
deploy/data/
├── roms/           # ROM 文件 (.zip, .nes, .wasm)
├── previews/       # 游戏预览图
├── screenshots/    # 游戏截图
├── description/    # 描述中的内嵌图片
└── .url-cache.json # URL 缓存（用于增量更新）
```

**文件命名：** `<sha256(url)前16位>.<扩展名>`
- 相同 URL 只下载一次（去重）
- 不同 URL 不会冲突

### 手动添加本地游戏

如果你有额外的 ROM 文件想添加：

1. 将 ROM 放入 `deploy/data/roms/`
2. 连接数据库插入记录：

```bash
docker compose exec postgres psql -U nesbox -d nesbox
```

```sql
INSERT INTO games (name, description, preview, rom, created_at, updated_at)
VALUES (
  '我的游戏',
  '游戏描述',
  '/files/previews/my-game.jpg',
  '/files/roms/my-game.nes',
  now(),
  now()
);
```

3. 刷新前端即可看到新游戏

---

## 增量更新游戏

当官方发布新游戏或更新现有游戏时：

### 方式一：使用增量脚本（推荐）

```bash
# 1. 运行增量本地化（仅下载新增资源）
node deploy/scripts/localize-incremental.mjs

# 2. 应用更新到数据库
docker compose exec -T postgres \
  psql -U nesbox -d nesbox < deploy/postgres/init/03-games-update.sql

# 3. 重启 server（可选，清除缓存）
docker compose restart server
```

**增量脚本行为：**
- 对比 `.url-cache.json`，仅下载新增/缺失的资源
- 生成 UPSERT SQL（按 `name` 去重）
- 新游戏：INSERT
- 已有游戏：UPDATE `rom/preview/screenshots/description/updated_at`
- **保留**用户已编辑的 `platform/series/kind/max_player` 字段

### 方式二：完全重新本地化

```bash
# 删除旧数据
rm -rf deploy/data/roms deploy/data/previews deploy/data/screenshots deploy/data/description
rm deploy/data/.url-cache.json

# 重新本地化
FORCE_REFRESH=1 node deploy/scripts/localize-games.mjs

# 重建数据库（会丢失用户数据！）
docker compose down
docker volume rm deploy_postgres-data
docker compose up -d
```

> ⚠️ **警告：** 方式二会删除所有用户数据（账号、好友、房间记录等），仅用于测试环境。

### 通过 GitHub Issue Webhook 添加的游戏

如果配置了 `GAMES_SYNC_URL`，新游戏会通过 webhook 自动添加，但 URL 仍是远程的。本地化方法见 [scripts/README.md](scripts/README.md#通过-github-issue-webhook-添加的游戏)。

---

## HTTPS 配置 (lucky 反向代理)

docker-compose 默认只暴露 HTTP。生产环境建议通过 [lucky](https://github.com/gdy666/lucky) 配置 HTTPS 反向代理。

### 1. 安装 lucky

参考 [lucky 官方文档](https://github.com/gdy666/lucky) 安装到 NAS。

### 2. 配置反向代理

在 lucky 管理界面添加反向代理规则：

| 配置项 | 值 |
|--------|-----|
| 监听端口 | `443` (HTTPS) |
| 域名 | `nesbox.yourdomain.com` |
| 目标地址 | `http://<nas-ip>:8080` |
| SSL 证书 | Let's Encrypt 自动签发 |

### 3. 配置 WebSocket 支持

lucky 默认支持 WebSocket，无需额外配置。如果遇到问题，检查：
- 目标地址使用 `http://` 而非 `https://`
- 超时时间设置为 3600s（1 小时）

### 4. 验证 HTTPS

```bash
curl https://nesbox.yourdomain.com/healthz
```

浏览器访问 `https://nesbox.yourdomain.com`，应看到安全锁标志。

### 5. 强制 HTTPS（可选）

在 lucky 中配置 HTTP → HTTPS 重定向：
- 监听 `80` 端口
- 重定向到 `https://nesbox.yourdomain.com`

### 其他反向代理方案

如果你使用其他反向代理（Caddy / Traefik / Nginx Proxy Manager），配置类似：
- 目标：`http://<nas-ip>:8080`
- 支持 WebSocket
- 超时：3600s

---

## 日常维护

### 查看日志

```bash
# 所有服务日志
docker compose logs -f

# 单个服务
docker compose logs -f server
docker compose logs -f webapp
docker compose logs -f postgres

# 最近 100 行
docker compose logs --tail=100 server
```

### 重启服务

```bash
# 重启所有
docker compose restart

# 重启单个
docker compose restart server
```

### 停止服务

```bash
# 停止（保留数据）
docker compose down

# 停止并删除数据卷（⚠️ 会丢失所有数据）
docker compose down -v
```

### 更新镜像

```bash
# 拉取最新代码
cd /path/to/nesbox
git pull
git submodule update --init --recursive

# 重新构建
cd deploy
docker compose build --no-cache
docker compose up -d
```

### 监控资源使用

```bash
# 查看容器资源占用
docker stats nesbox-postgres nesbox-server nesbox-webapp

# 查看磁盘使用
du -sh deploy/data/
docker system df
```

---

## 备份与恢复

### 备份数据库

```bash
# 备份所有数据
docker compose exec -T postgres \
  pg_dump -U nesbox -d nesbox \
  > backup-$(date +%Y%m%d-%H%M%S).sql

# 仅备份游戏数据（不含用户）
docker compose exec -T postgres \
  pg_dump -U nesbox -d nesbox --table=public.games \
  > games-backup.sql
```

### 备份游戏资源

```bash
# 打包 data 目录
tar -czf data-backup-$(date +%Y%m%d).tar.gz deploy/data/
```

### 备份配置

```bash
cp deploy/.env deploy/.env.backup
```

### 恢复数据库

```bash
# 恢复完整备份
docker compose exec -T postgres \
  psql -U nesbox -d nesbox \
  < backup-20240101-120000.sql

# 恢复后重启 server
docker compose restart server
```

### 恢复游戏资源

```bash
# 解压备份
tar -xzf data-backup-20240101.tar.gz -C /path/to/nesbox/

# 重启 webapp（重新挂载）
docker compose restart webapp
```

### 自动备份脚本

创建 `deploy/backup.sh`：

```bash
#!/bin/bash
set -e

BACKUP_DIR="/volume1/backups/nesbox"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# 备份数据库
docker compose -f /volume1/docker/nesbox/deploy/docker-compose.yml exec -T postgres \
  pg_dump -U nesbox -d nesbox \
  > "$BACKUP_DIR/db-$DATE.sql"

# 备份配置
cp /volume1/docker/nesbox/deploy/.env "$BACKUP_DIR/env-$DATE"

# 删除 30 天前的备份
find "$BACKUP_DIR" -name "*.sql" -mtime +30 -delete
find "$BACKUP_DIR" -name "env-*" -mtime +30 -delete

echo "Backup completed: $BACKUP_DIR"
```

```bash
chmod +x deploy/backup.sh

# 添加 crontab（每天凌晨 2 点）
echo "0 2 * * * /volume1/docker/nesbox/deploy/backup.sh" | crontab -
```

---

## 升级指南

### 升级代码

```bash
cd /path/to/nesbox

# 拉取最新代码
git pull
git submodule update --init --recursive

# 重新构建镜像
cd deploy
docker compose build --no-cache

# 重启服务
docker compose up -d

# 检查日志
docker compose logs -f server
```

### 升级数据库 Schema

如果新版本包含数据库 migration：

```bash
# 1. 备份数据库
docker compose exec -T postgres pg_dump -U nesbox -d nesbox > backup-before-upgrade.sql

# 2. 运行 diesel migration（需要 diesel_cli）
docker compose exec server diesel migration run

# 或者手动执行 SQL：
docker compose exec -T postgres psql -U nesbox -d nesbox < packages/server/migrations/<new-migration>/up.sql
```

### 回滚

如果升级失败：

```bash
# 停止服务
docker compose down

# 恢复代码
git checkout <previous-tag>

# 恢复数据库
docker compose exec -T postgres psql -U nesbox -d nesbox < backup-before-upgrade.sql

# 重新构建并启动
docker compose build
docker compose up -d
```

---

## 故障排查

### 容器无法启动

```bash
# 查看详细日志
docker compose logs server
docker compose logs postgres
docker compose logs webapp

# 检查配置
docker compose config
```

**常见原因：**
- `.env` 未配置 `POSTGRES_PASSWORD` 或 `SECRET`
- 端口被占用：修改 `WEBAPP_PORT`
- 磁盘空间不足：`df -h`

### 数据库连接失败

```bash
# 检查 postgres 健康状态
docker compose ps postgres

# 手动连接测试
docker compose exec postgres psql -U nesbox -d nesbox -c "SELECT 1"

# 检查 server 日志
docker compose logs server | grep -i database
```

**常见原因：**
- postgres 未完全启动：等待 healthcheck 通过
- `DATABASE_URL` 配置错误：检查 `.env` 中的密码

### 前端无法访问 API

```bash
# 测试 API 连通性
curl http://localhost:8080/api/playground

# 检查 nginx 配置
docker compose exec webapp nginx -t

# 查看 nginx 日志
docker compose logs webapp
```

**常见原因：**
- server 未启动：`docker compose ps server`
- nginx 反代配置错误：检查 `deploy/webapp/nginx.conf`

### 游戏加载失败（ROM 404）

```bash
# 检查文件是否存在
ls -la deploy/data/roms/

# 检查 nginx 挂载
docker compose exec webapp ls /usr/share/nginx/html/files/roms/

# 检查数据库 URL
docker compose exec postgres psql -U nesbox -d nesbox \
  -c "SELECT name, rom FROM games LIMIT 5"
```

**常见原因：**
- 本地化脚本未运行或失败
- `data/` 目录未正确挂载
- 数据库中 URL 仍是远程地址

### WebSocket 连接失败

```bash
# 测试 WebSocket 端点
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: sgVbSQBQb3V0aG9y" \
  http://localhost:8080/api/subscriptions
```

**常见原因：**
- nginx 未配置 WebSocket 升级头
- 反向代理（lucky）未启用 WebSocket 支持
- 防火墙阻断长连接

### 构建失败

```bash
# 清除构建缓存
docker compose build --no-cache

# 检查 Dockerfile 语法
docker build -f deploy/server/Dockerfile -t test .
docker build -f deploy/webapp/Dockerfile -t test .
```

**常见原因：**
- 网络问题（无法下载依赖）
- 磁盘空间不足
- Docker 版本过低

---

## 进阶配置

### 使用外部 PostgreSQL

如果你已有 PostgreSQL 实例：

1. 注释掉 `docker-compose.yml` 中的 `postgres` 服务
2. 修改 `server` 的 `DATABASE_URL`：

```env
DATABASE_URL=postgres://user:pass@your-host:5432/nesbox
```

3. 手动执行初始化 SQL：

```bash
psql -h your-host -U user -d nesbox < deploy/postgres/init/01-schema.sql
psql -h your-host -U user -d nesbox < deploy/postgres/init/02-games.sql
```

### 使用外部对象存储

如果游戏资源存储在 S3 / OSS：

1. 修改 `CORS_ORIGIN` 指向你的存储域名：

```env
CORS_ORIGIN=https://your-bucket.s3.amazonaws.com
```

2. 重新构建前端：

```bash
docker compose build webapp
docker compose up -d webapp
```

3. 数据库中 URL 保持远程地址，前端会通过 `CORS_ORIGIN` 代理访问

### 多实例部署

如果需要负载均衡：

1. 使用外部负载均衡器（nginx / traefik）
2. 启动多个 webapp 实例：

```bash
docker compose up -d --scale webapp=3
```

3. 配置负载均衡器分发到多个端口

> **注意：** server 是有状态的（WebSocket 连接），需要 sticky session 或共享状态。

---

## 获取帮助

- **项目仓库：** https://github.com/mantou132/nesbox
- **Issue 反馈：** https://github.com/mantou132/nesbox/issues
- **Discord 社区：** https://discord.gg/pBkC7azY
- **本地化脚本问题：** 查看 [scripts/README.md](scripts/README.md)

---

## 许可证

本项目遵循原 NESBox 项目的开源许可证。游戏 ROM 版权归原作者所有，请遵守当地法律法规。

> **免责声明：** 本项目仅供学习交流使用，请勿用于商业用途。下载的游戏 ROM 请在 24 小时内删除，支持正版游戏。
