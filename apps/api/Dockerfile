FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w @evidence-trust/api

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
# Same image runs three roles: `node dist/server.js` (API), `node dist/worker.js` (worker), `node dist/cli/migrate.js` (release job)
CMD ["node", "dist/server.js"]
