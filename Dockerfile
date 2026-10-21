# Foundry core image: one Node process (gateway + agent + WS + web UI) plus the
# sandbox sidecars it launches on the host's Docker daemon at runtime. Build
# context = the whole repo (see .dockerignore); the pnpm lockfile pins deps.
#
# NOTE for operators: the core talks to /var/run/docker.sock (socket-in-socket)
# to launch sibling sandbox containers — see docs/setup.md §compose. That is
# the trusted-gateway side of the trust boundary (guardrail #1); SANDBOX
# containers never get the socket (guardrail #3).

FROM node:22-bookworm-slim AS build

# Toolchain for the two native deps (better-sqlite3, sqlite-vec prebuilds when
# matching; build from source otherwise).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm -r build  # topo-ordered: protocol → sdk-ts → core → (web SPA build)

# Runtime: source + node_modules + the three built outputs (protocol dist is
# core's runtime dep; apps/web/build is the SAME-ORIGIN SPA).
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV FOUNDRY_PORT=8787
ENV FOUNDRY_WEB_DIR=/src/apps/web/build

WORKDIR /src
COPY --from=build /src ./

EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.FOUNDRY_PORT || 8787) + '/healthz').then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "apps/core/dist/main.js"]