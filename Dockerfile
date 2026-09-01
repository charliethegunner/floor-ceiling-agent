# syntax=docker/dockerfile:1

# Phase 25.0 production image for src/server/index.ts (the Phase 24.0 HTTP
# runtime wrapper). This project has NO tsc-emit build step and never has -
# see docs/DEPLOYMENT.md §0: every entrypoint (bin/translate.ts,
# src/server/index.ts, the worker-thread scripts themselves) runs directly
# under tsx. That is not a shortcut this Dockerfile works around - it is a
# real, load-bearing part of this codebase's architecture:
# src/layer1/worker-pool.ts and src/layer1/brep/brep-worker-pool.ts spawn
# worker_threads with `execArgv: ['--import', 'tsx']` against a hardcoded
# `.ts` script path (worker-pool-worker.ts / brep-worker.ts), so a
# tsc-compiled `.js`-only image would leave every worker thread unable to
# find its own entry point. `tsx` (along with ts-morph/z3-solver/
# opencascade.js, the three real verification engines) was promoted from
# devDependencies to dependencies in package.json specifically so `npm ci
# --omit=dev` below installs a genuinely complete, working runtime set -
# verified empirically before this file was written: a scratch `npm ci
# --omit=dev` install (20 packages, vs. 98 with devDependencies) booted
# src/server/index.ts, passed real /healthz and /ready checks, and exited
# 143 on a real SIGTERM.
#
# The "build" stage below still earns the word: it runs the real
# `tsc --noEmit` type-check as a genuine build gate (a type error fails
# `docker build`, not just CI) - it just doesn't emit different JS output,
# because this project's real worker-spawning code doesn't consume any.

# Node 24, not 20: empirically found while validating this file (Phase
# 25.0) that Node 20.20.2 cannot run this project's worker_threads at all -
# every worker spawned via `execArgv: ['--import', 'tsx']`
# (src/layer1/worker-pool.ts, src/layer1/brep/brep-worker-pool.ts) throws
# `ERR_UNKNOWN_FILE_EXTENSION` for its own `.ts` entry point, isolated with a
# controlled test (identical Linux container and tsx version, Node version
# the only variable changed) against a real 'spatial' verify() call - fails
# on node:20-slim, succeeds on node:24-slim. Node 20 is also past its LTS
# end-of-life by now. See docs/DEPLOYMENT.md §1.4/appendix.
FROM node:24-slim AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# Stage: typecheck - a full install (dev included) so `tsc --noEmit` sees
# `typescript` itself. Build fails here on a real type error.
# ---------------------------------------------------------------------------
FROM base AS typecheck
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY lib ./lib
COPY src ./src
RUN npx tsc --noEmit

# ---------------------------------------------------------------------------
# Stage: production-deps - only what package.json's "dependencies" block
# lists (tsx, ts-morph, z3-solver, opencascade.js, fast-check) plus their
# own transitive deps. No typescript/vitest/@grpc - those are dev-only /
# unused by src/server/index.ts's real import graph (docs/DEPLOYMENT.md §2.1).
# ---------------------------------------------------------------------------
FROM base AS production-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage: runtime - the actual image. Depends on `typecheck` completing (a
# real build-order dependency, not just documentation) so a broken build
# never produces a runnable image.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Real default is 8080 (src/server/config.ts) when PORT is unset - this
# image standardizes the container's own listening port on 3000 instead,
# matching this Dockerfile's HEALTHCHECK and EXPOSE below.
ENV PORT=3000

COPY --from=typecheck /app/tsconfig.json ./tsconfig.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./
COPY lib ./lib
COPY src ./src

# node:24-slim already ships a non-root "node" user (uid 1000) - reuse it
# rather than creating a new one, and hand it ownership of what it needs to
# read/execute.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# LLM_BASE_URL and LLM_MODEL are required (src/server/config.ts fails
# closed at startup if either is missing) and are deployment-time
# configuration, not baked into the image - supply them via `docker run -e`
# / your orchestrator's env injection. See docs/DEPLOYMENT.md §2.2 for the
# full env var reference (MAX_RETRIES, WORKER_POOL_SIZE,
# BREP_WORKER_POOL_SIZE, WORKER_RSS_THRESHOLD_MB, BREP_RSS_THRESHOLD_MB,
# LLM_TIMEOUT_MS, LLM_API_KEY).

# node:24-slim has no curl/wget - Node's own built-in fetch (Node 18+) needs
# no extra package installed for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
