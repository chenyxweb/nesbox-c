# 本地化脚本说明

本目录包含 NESBox 游戏数据本地化脚本，用于将官方远程资源（ROM、预览图、截图）下载到 NAS 本地，实现完全离线运行。

## 数据源

脚本从 **官方 NESBox API** 获取游戏数据：

- **API 端点**: `https://api.xianqiao.wang/nesbox/guestgraphql`
- **游戏数量**: 164 条（实时同步官方数据库）
- **认证**: 无需认证（guestgraphql 是公开端点）
- **格式**: GraphQL JSON（结构化数据，无需解析 markdown）

## 脚本列表

| 脚本 | 用途 | 使用场景 |
|------|------|----------|
| `lib.mjs` | 公共库（被其他脚本导入） | - |
| `localize-games.mjs` | 完整本地化 | **首次部署**前运行 |
| `localize-incremental.mjs` | 增量本地化 | 官方发布新游戏后运行 |

## 前置要求

- **Node.js 18+**（脚本使用原生 `fetch` 与 ES Modules）
- 网络可访问官方 API（`api.xianqiao.wang`）
- 约 2-5 GB 磁盘空间（取决于游戏数量）

## 环境变量

所有脚本支持以下环境变量（可在 `deploy/.env` 中配置，或运行时传入）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NESBOX_API_URL` | `https://api.xianqiao.wang/nesbox/guestgraphql` | 官方 API 地址 |
| `LOCAL_FILES_URL_PREFIX` | `/files` | 本地化后 URL 前缀，需与 nginx 挂载路径一致 |
| `LOCALIZE_CONCURRENCY` | `6` | 下载并发数，NAS 建议 4-8 |
| `LOCALIZE_RETRIES` | `3` | 下载失败重试次数 |

## 使用方式

### 1. 首次部署：完整本地化

```bash
# 进入项目根目录
cd /path/to/nesbox

# 运行完整本地化（从 API 获取数据，下载所有资源，生成 02-games.sql）
node deploy/scripts/localize-games.mjs

# 启动服务
cd deploy
docker compose up -d --build
```

**输出文件：**
- `deploy/data/roms/*` - ROM 文件
- `deploy/data/previews/*` - 预览图
- `deploy/data/screenshots/*` - 截图
- `deploy/data/description/*` - description 内嵌图片
- `deploy/data/.url-cache.json` - URL 缓存（用于增量更新）
- `deploy/postgres/init/02-games.sql` - 本地化后的 SQL（COPY 格式）

### 2. 后续更新：增量本地化

当官方发布新游戏或更新现有游戏时：

```bash
# 1. 运行增量本地化（仅下载新增资源，生成 UPSERT SQL）
node deploy/scripts/localize-incremental.mjs

# 2. 将更新应用到数据库
docker compose -f deploy/docker-compose.yml exec -T postgres \
  psql -U nesbox -d nesbox < deploy/postgres/init/03-games-update.sql

# 3. 重启 server 使缓存失效（可选）
docker compose -f deploy/docker-compose.yml restart server
```

**增量脚本行为：**
- 对比 `.url-cache.json`，仅下载新增/缺失的资源
- 生成 UPSERT SQL（`INSERT ... ON CONFLICT (name) DO UPDATE`）
- 新游戏：INSERT
- 已有游戏：UPDATE `rom/preview/screenshots/description/updated_at`
- **保留**用户可能已编辑的 `platform/series/kind/max_player` 字段

### 3. 强制刷新（重新下载所有资源）

```bash
# 删除缓存，强制重新下载
rm -rf deploy/data/roms deploy/data/previews deploy/data/screenshots deploy/data/description
rm deploy/data/.url-cache.json

# 重新运行
node deploy/scripts/localize-games.mjs
```

## 输出目录结构

```
deploy/data/
├── roms/                    # ROM 文件 (.zip, .nes, .wasm 等)
│   ├── a1b2c3d4e5f6g7h8.zip
│   └── ...
├── previews/                # 游戏预览图
│   ├── 1234567890abcdef.jpg
│   └── ...
├── screenshots/             # 游戏截图
│   └── ...
├── description/             # description 字段中的内嵌图片
│   └── ...
├── .url-cache.json          # URL → 本地路径映射缓存
└── .failed-downloads.json   # 下载失败列表（如有）
```

**文件命名规则：** `<sha256(url)前16位>.<原始扩展名>`
- 相同 URL 只会下载一次（去重）
- 不同 URL 即使文件名相同也不会冲突

## 故障排查

### API 请求失败

```bash
# 测试 API 连通性
curl -sL 'https://api.xianqiao.wang/nesbox/guestgraphql?operationName=getGames' \
  -H 'content-type: application/json' \
  --data-raw '{"query":"query getGames { games { id name } }","variables":{}}' \
  | jq '.data.games | length'
```

如果 API 不可用，可以：
1. 检查网络连接
2. 稍后重试（官方服务器可能维护）
3. 使用 `NESBOX_API_URL` 环境变量指向备用 API

### 下载失败

脚本会重试失败项（默认 3 次）。如果仍有失败：

1. 查看失败列表：`deploy/data/.failed-downloads.json`
2. 检查网络（GitHub 资源可能需要代理）
3. 重新运行脚本（已下载的会跳过）

### 资源 404

如果某些游戏加载时提示 404：

1. 检查 `deploy/data/` 下对应文件是否存在
2. 检查数据库中 URL 是否已替换为 `/files/...`
3. 检查 nginx 挂载：`docker compose exec webapp ls /usr/share/nginx/html/files`

### 数据库未更新

增量脚本生成的 SQL 需要手动应用：

```bash
# 检查 SQL 文件是否存在
ls -la deploy/postgres/init/03-games-update.sql

# 手动执行
docker compose -f deploy/docker-compose.yml exec -T postgres \
  psql -U nesbox -d nesbox < deploy/postgres/init/03-games-update.sql
```

## 性能建议

- **并发数**：NAS 设备建议 `LOCALIZE_CONCURRENCY=4`，避免占满带宽
- **磁盘**：SSD 可显著提升大量小文件写入性能
- **网络**：GitHub 资源下载可能需要代理，可设置 `HTTPS_PROXY` 环境变量

```bash
# 使用代理下载
HTTPS_PROXY=http://proxy:port node deploy/scripts/localize-games.mjs
```
