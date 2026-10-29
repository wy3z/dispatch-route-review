# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . ./
RUN pnpm build

# The web image contains only Next's traced production output. Autotask
# credentials are deliberately not copied into this image or its service.
FROM node:24.19.0-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    AUTH_MODE=forward-auth \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# The worker has TypeScript execution support and source. It is the only target
# whose Compose service receives Autotask credentials.
FROM build AS cache-worker
ENV NODE_ENV=production
USER node
CMD ["pnpm", "cache:worker"]
