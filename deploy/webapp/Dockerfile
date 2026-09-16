# syntax=docker/dockerfile:1.6
# ============================================================
# NESBox Webapp (Vite + gemjs + TypeScript)
# 构建上下文: 项目根目录
# 构建命令:   docker build -f deploy/webapp/Dockerfile -t nesbox/webapp:local .
#
# 构建参数 (通过 docker-compose.yml 或 --build-arg 注入):
#   API_BASE             前端调用后端的基路径，默认 /api
#   CORS_ORIGIN          外部资源 CORS 代理域名，留空使用相对路径
#   AI_SEARCH_BASE       AI 搜索服务地址，留空禁用
#   AI_COMPLETIONS_BASE  AI 问答服务地址，留空禁用
# ============================================================

# ---------- 构建阶段 ----------
FROM node:20-bookworm AS builder

WORKDIR /app

# 构建参数 → 环境变量（vite.config.ts 中通过 process.env 读取）
ARG API_BASE=/api
ARG CORS_ORIGIN=
ARG AI_SEARCH_BASE=
ARG AI_COMPLETIONS_BASE=
ENV API_BASE=$API_BASE \
    CORS_ORIGIN=$CORS_ORIGIN \
    AI_SEARCH_BASE=$AI_SEARCH_BASE \
    AI_COMPLETIONS_BASE=$AI_COMPLETIONS_BASE \
    # 禁用 husky（容器内不需要 git hooks）
    HUSKY=0 \
    # 跳过 puppeteer 下载 Chromium：前端构建用不到，受限网络无法访问 storage.googleapis.com
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    # 跳过 cypress 下载测试二进制：e2e 不参与前端构建，避免访问 download.cypress.io 失败
    CYPRESS_INSTALL_BINARY=0 \
    # yarn 网络优化
    YARN_NETWORK_TIMEOUT=600000

# 1) 先复制依赖清单，利用 Docker 层缓存
COPY package.json yarn.lock ./
COPY patches ./patches
COPY biome.jsonc ./

# 2) 复制所有 workspace 的 package.json（yarn workspaces 需要解析全部成员）
#    仅复制 package.json，不复制源码，最大化缓存命中率
COPY packages/arcade/package.json     packages/arcade/
COPY packages/config/package.json     packages/config/
COPY packages/e2e/package.json        packages/e2e/
COPY packages/ecs/package.json        packages/ecs/
COPY packages/fceux/package.json      packages/fceux/
COPY packages/mtapp/package.json      packages/mtapp/
COPY packages/sandbox/package.json    packages/sandbox/
COPY packages/toolbox/package.json    packages/toolbox/
COPY packages/wasm4/package.json      packages/wasm4/
COPY packages/webapp/package.json     packages/webapp/
COPY packages/zombie/package.json     packages/zombie/
COPY games/tetris/package.json        games/tetris/

# 3) 安装依赖（postinstall 会自动执行 patch-package 应用 patches/）
RUN yarn install --frozen-lockfile --network-timeout 600000

# 4) 复制前端构建所需的源码
#    仅复制 webapp 及其 workspace 依赖，跳过 Rust / Flutter / 测试 / 工具包
COPY packages/config    packages/config
COPY packages/ecs       packages/ecs
COPY packages/arcade    packages/arcade
COPY packages/fceux     packages/fceux
COPY packages/wasm4     packages/wasm4
COPY packages/sandbox   packages/sandbox
COPY packages/mtapp     packages/mtapp
COPY packages/webapp    packages/webapp

# 5) 构建前端产物 → packages/webapp/dist
RUN yarn --cwd packages/webapp build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine

# 替换默认 nginx 配置
COPY deploy/webapp/nginx.conf /etc/nginx/conf.d/default.conf

# 复制前端构建产物
COPY --from=builder /app/packages/webapp/dist /usr/share/nginx/html

# 本地化资源目录（由 docker-compose volumes 挂载到此处）
# 提前创建目录，避免挂载点不存在导致 nginx 启动失败
RUN mkdir -p /usr/share/nginx/html/files

EXPOSE 80

# nginx:alpine 自带 wget，可直接用于健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
