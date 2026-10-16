# 文件职责：在可重复的 Bun 环境中构建工作台前端，并打包 API 与后台 worker 运行源代码。
FROM oven/bun:1.3.9 AS build

# vue-tsc uses Node's CommonJS and symlink resolution; Bun's node fallback is insufficient.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
# Hoisted dependencies avoid Bun 1.3.9 resolving copied workspace symlinks incorrectly.
RUN bun install --frozen-lockfile --linker=hoisted

COPY . .
RUN bun run build

FROM oven/bun:1.3.9
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /home/ai-distill /app/.storage && chown -R 10001:10001 /home/ai-distill /app/.storage
ENV HOME=/home/ai-distill
USER 10001:10001
CMD ["bun", "server/index.ts"]
