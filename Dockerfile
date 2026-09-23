# syntax=docker/dockerfile:1
#
# Crayon Cost MCP Server — production image for Azure Container Apps.
#
# Design notes:
#  - node:24-slim (Debian bookworm) matches the Node major used in development.
#  - canvas (chart rendering) ships a self-contained N-API prebuild that bundles
#    cairo/pango/libpng/librsvg, so the runtime stage needs NO native libraries.
#    The build toolchain is kept in the builder only, as a fallback for platforms
#    without a matching prebuild (e.g. arm64).
#  - Fonts ARE required: chart titles/axis labels are rasterised by fontconfig, so
#    without them text silently disappears from the generated PNGs.
#  - Logs go to stderr; the container filesystem is ephemeral, so file logging is
#    opt-in via LOG_TO_FILE.

# ---------------------------------------------------------------------------
# Stage 1: build
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /app

# Toolchain for the node-gyp fallback (only used if no canvas prebuild matches).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libgif-dev \
    libjpeg-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so the dependency layer is cached independently
# of source changes.
COPY package.json package-lock.json* tsconfig.json ./

# `npm ci` requires a lockfile. This repository gitignores package-lock.json, so
# fall back to `npm install` to keep clean-clone/CI builds working.
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      echo "Using npm ci (lockfile present)"; \
      npm ci --no-audit --no-fund; \
    else \
      echo "No lockfile found; falling back to npm install"; \
      npm install --no-audit --no-fund; \
    fi

COPY src ./src
RUN npm run build

# Strip build-time-only artifacts from dist before it is copied into the runtime
# stage. Type declarations and their maps (.d.ts/.d.ts.map, ~88K) are consumed by
# tooling, never by Node at run time. Source maps (~160K) are only useful if the
# runtime opts in via --enable-source-maps, which this image does not do; shipping
# them would merely expose original sources inside the deployed container.
RUN find dist -name '*.d.ts' -delete \
    && find dist -name '*.d.ts.map' -delete \
    && find dist -name '*.js.map' -delete \
    && echo "dist after strip:" && ls -la dist

# Prune to production dependencies in a separate, throwaway install so the
# runtime stage copies a clean tree.
RUN --mount=type=cache,target=/root/.npm \
    rm -rf node_modules && \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

# Only fonts are needed at runtime. canvas loads the rest of its native stack
# from its own build/Release directory (verified via ldd), so cairo/pango/rsvg
# packages are deliberately omitted. fontconfig removes the "Cannot load default
# config file" warning; the DejaVu/Liberation families are what chart-generator
# requests by name.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

WORKDIR /app

# Environment defaults. Azure Container Apps overrides these from the app spec;
# listening on 0.0.0.0 is required for ingress to reach the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3003 \
    LOG_LEVEL=error

# Production dependencies (already pruned in the builder).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Fail the build if non-production payload ever reaches the image. These asserts
# turn "the .dockerignore / COPY rules drifted" from a silent regression into a
# broken build.
#
# Checks are deliberately name-specific rather than pattern-based. For example
# `node_modules/@types` cannot be flagged wholesale because production packages
# ship types there (@types/triple-beam comes from winston), and `.bin` legitimately
# holds executables from production deps (prebuild-install via canvas, semver, rc).
# The list below is exactly this project's devDependencies plus common build tools.
RUN set -eu; \
    for forbidden in scripts src tsconfig.json Dockerfile .env .env.example \
                     docker-compose.yml README.md; do \
      if [ -e "/app/$forbidden" ]; then \
        echo "BUILD GUARD FAILED: /app/$forbidden must not be in the runtime image" >&2; \
        exit 1; \
      fi; \
    done; \
    for devpkg in typescript @types/node @types/express @types/compression \
                  @types/opossum prettier eslint mocha jest ts-node; do \
      if [ -e "node_modules/$devpkg" ]; then \
        echo "BUILD GUARD FAILED: build-only dependency '$devpkg' present in runtime image" >&2; \
        exit 1; \
      fi; \
    done; \
    if find dist \( -name '*.d.ts' -o -name '*.map' \) | grep -q .; then \
      echo "BUILD GUARD FAILED: declaration/source-map files present in dist" >&2; \
      exit 1; \
    fi; \
    echo "Runtime image payload guard passed."

# Run unprivileged. uid/gid 1001 avoids the built-in `node` user (uid 1000) and
# is stable across image rebuilds so ACA securityContext stays valid.
RUN groupadd -g 1001 nodejs \
    && useradd -m -u 1001 -g nodejs nodejs \
    && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3003

# Health check for `docker run` / compose. Azure Container Apps ignores
# Dockerfile HEALTHCHECK and uses the probe settings on the container app
# instead — configure the same /health path there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
