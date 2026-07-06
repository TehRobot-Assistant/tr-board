# TR Board — single-image build (web SPA + API server)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server \
  && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# npm workspaces hoist all deps into the root node_modules
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist
ENV PORT=8841 \
    UPLOADS_DIR=/data/uploads \
    WEB_DIST=/app/web/dist
# pre-create with node ownership so the named volume inherits it
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME /data/uploads
EXPOSE 8841
USER node
CMD ["node", "server/dist/index.js"]
