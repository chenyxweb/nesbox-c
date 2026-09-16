# syntax=docker/dockerfile:1.6
# ============================================================
# NESBox Server (Rust + Actix-web + Diesel + PostgreSQL)
# 构建上下文: 项目根目录
# 构建命令:   docker build -f deploy/server/Dockerfile -t nesbox/server:local .
# ============================================================

# ---------- 构建阶段 ----------
FROM rust:1-bookworm AS builder

WORKDIR /build

# 安装构建时依赖（openssl 头文件用于 openssl-sys crate）
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# 1) 先复制 Cargo.lock 与 server 的 Cargo.toml，用于依赖预编译
#    这里不使用 workspace 上下文，将 server 作为独立 crate 构建
COPY Cargo.lock ./
COPY packages/server/Cargo.toml ./

# 2) 创建 stub 源码，触发依赖编译（利用 Docker 层缓存，避免每次重新编译依赖）
RUN mkdir -p ./src \
    && echo 'fn main() { println!("Dummy!"); }' > ./src/main.rs \
    && cargo build --release \
    && rm -rf ./src

# 3) 复制真实源码
COPY packages/server/src ./src

# 4) 更新 main.rs 的 mtime，强制 cargo 重新编译入口（否则会复用 stub 产物）
RUN touch -a -m ./src/main.rs \
    && cargo build --release

# ---------- 运行阶段 ----------
FROM debian:bookworm-slim

# 运行时依赖:
#   libpq5       - PostgreSQL 客户端库
#   ca-certificates - HTTPS 请求（webhook / 外部同步）
#   openssl      - libssl 运行时（rust openssl crate）
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        ca-certificates \
        libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --shell /usr/sbin/nologin nesbox

COPY --from=builder /build/target/release/server /usr/local/bin/server

# 使用非 root 用户运行，降低容器逃逸风险
USER nesbox

EXPOSE 8080

# 健康检查: 访问 /playground（无需鉴权的 GraphQL Playground 页面）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8080/playground || exit 1

ENTRYPOINT ["/usr/local/bin/server"]
