# syntax=docker/dockerfile:1.7
#
# The setup service: zvm-node's CLI for the contracts it owns (Uniswap V2, the
# marketplace, the farm), and every app with its dependencies installed, for
# their own deploy scripts and their page builds. Built from the repository
# root, so each app comes from its submodule; .dockerignore keeps out the
# node_modules and dist of a working tree.

FROM golang:1.25-alpine AS cli
WORKDIR /src
COPY zvm-node/go.mod zvm-node/go.sum ./
COPY zvm-node/zvm-core/go.mod zvm-node/zvm-core/go.sum ./zvm-core/
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY zvm-node/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/zvm-node ./cmd/zvm-node

# zvm-core's CLI, for the seed's bridge deposit: a NoM block signed with a dev key.
FROM golang:1.25-alpine AS zvm
WORKDIR /src
COPY zvm-core/go.mod zvm-core/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY zvm-core/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/zvm ./cmd/zvm

FROM node:22-alpine
RUN apk add --no-cache wget
COPY --from=cli /out/zvm-node /usr/local/bin/zvm-node
COPY --from=zvm /out/zvm /usr/local/bin/zvm

WORKDIR /apps
# verify-tokens submits WZNN's and WQSR's sources from a zvm-node checkout.
COPY zvm-node/contracts zvm-node/contracts
COPY zvm-explorer zvm-explorer
COPY zvm-glyphswap zvm-glyphswap
COPY zvm-karum zvm-karum
COPY zvm-nft zvm-nft
COPY zvm-mozaic zvm-mozaic
COPY zvm-status zvm-status
COPY zvm-zchan zvm-zchan
COPY zvm-zns zvm-zns
COPY zvm-spark zvm-spark

# One install per package, from its lockfile. Spark's contract artifacts are
# not committed, so they are compiled here, once.
RUN --mount=type=cache,target=/root/.npm set -e; \
    for d in zvm-explorer zvm-glyphswap zvm-karum zvm-nft zvm-mozaic zvm-status/web \
             zvm-zchan/web zvm-zchan/contracts zvm-zns/web zvm-zns/contracts zvm-spark/web zvm-spark/contracts; do \
      echo "== $d"; (cd "$d" && npm ci --no-audit --no-fund --loglevel=error); \
    done; \
    cd zvm-spark/contracts && npm run build
# Changes whenever the apps do, so setup knows to rebuild the pages.
RUN date -u +%s >/apps/.built-from

# accounts.mjs resolves viem from Mozaic's install, the nearest node_modules above it.
RUN ln -s zvm-mozaic/node_modules /apps/node_modules
COPY setup/accounts.mjs setup/admin.mjs setup/check.mjs setup/seed.mjs /apps/
COPY setup/setup.sh /usr/local/bin/setup
RUN chmod +x /usr/local/bin/setup
ENTRYPOINT ["setup"]
