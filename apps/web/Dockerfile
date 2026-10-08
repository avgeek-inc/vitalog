FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY vendor ./vendor
RUN npm ci
COPY apps/web ./apps/web
COPY src/auth/account-contracts.ts ./src/auth/account-contracts.ts
COPY src/domain ./src/domain
COPY src/registry ./src/registry
RUN node --run build:web

FROM node:24.16.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/src/components/ui/LICENSE /app/notices/vitalog-ui/LICENSE
COPY --from=build --chown=node:node /app/apps/web/src/components/ui/NOTICE.md /app/notices/vitalog-ui/NOTICE.md
COPY --from=build --chown=node:node /app/node_modules/@avgeek-oss/design-system/LICENSE /app/notices/avgeek-oss-design-system/LICENSE
COPY --from=build --chown=node:node /app/node_modules/@avgeek-oss/design-system/NOTICE /app/notices/avgeek-oss-design-system/NOTICE
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
