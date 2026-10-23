# Control-plane server image. Build from the repo root:
#   docker build -f deploy/server.Dockerfile -t orch/server .
# Config is read from /data/orch.server.json (see deploy/orch.server.example.json);
# it must set "bind": "0.0.0.0:7800" so the server is reachable from outside the container.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/runner/package.json packages/runner/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/web packages/web
RUN bun run --filter @orch/web build

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/runner/package.json packages/runner/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile --production --filter @orch/server

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production \
    ORCH_SERVER_CONFIG=/data/orch.server.json
COPY --from=deps /app ./
COPY packages/protocol packages/protocol
COPY packages/server/src packages/server/src
COPY packages/server/drizzle packages/server/drizzle
COPY --from=build /app/packages/web/dist packages/web/dist
# Named volumes inherit this ownership on first use, so the unprivileged user can write the DB.
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 7800
ENTRYPOINT ["bun", "packages/server/src/main.ts"]
CMD ["serve"]
