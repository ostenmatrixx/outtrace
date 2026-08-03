# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

FROM dependencies AS build
ARG VITE_API_BASE_URL=https://api.example.invalid
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY tsconfig.base.json eslint.config.js ./
COPY apps apps
COPY packages packages
COPY database database
RUN npm run build

FROM node:22-alpine AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --from=production-dependencies --chown=node:node /app/apps apps
COPY --from=production-dependencies --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /app/database database
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --from=production-dependencies --chown=node:node /app/apps apps
COPY --from=production-dependencies --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/apps/worker/dist apps/worker/dist
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist
USER node
EXPOSE 3001
CMD ["node", "apps/worker/dist/main.js"]

FROM nginxinc/nginx-unprivileged:1.30-alpine AS dashboard
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
