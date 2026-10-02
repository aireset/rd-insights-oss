# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=rd-insights-pnpm,target=/pnpm/store corepack pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY . .
RUN corepack pnpm --filter @rd/shared build
RUN cd apps/api && npx prisma generate
RUN corepack pnpm --filter @rd/web build
RUN corepack pnpm --filter @rd/api build

FROM node:22-alpine AS runtime
ENV WEB_DIST_DIR=/app/web PORT=22501 NODE_ENV=production
WORKDIR /app/apps/api
# node_modules completo (inclui devDep "prisma", usada no boot p/ migrate deploy);
# mantém a mesma arvore do workspace p/ resolver symlinks pnpm (@rd/shared etc.)
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /repo/packages/shared /app/packages/shared
COPY --from=build /repo/apps/api/dist /app/apps/api/dist
COPY --from=build /repo/apps/api/prisma /app/apps/api/prisma
COPY --from=build /repo/apps/api/package.json /app/apps/api/package.json
COPY --from=build /repo/apps/web/dist /app/web
ENV PATH="/app/apps/api/node_modules/.bin:/app/node_modules/.bin:${PATH}"
EXPOSE 22501
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
