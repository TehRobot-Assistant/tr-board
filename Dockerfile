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
LABEL org.opencontainers.image.source="https://github.com/TehRobot-Assistant/tr-board"
LABEL org.opencontainers.image.description="Self-hosted Trello with the paid features free"
LABEL org.opencontainers.image.licenses="MIT"
# Unraid reads these from the container (image labels are inherited), so a
# Compose Manager install gets the icon + WebUI link instead of a "?" tile.
LABEL net.unraid.docker.icon="https://raw.githubusercontent.com/TehRobot-Assistant/tr-board/main/unraid/tr-board-icon.png"
LABEL net.unraid.docker.webui="http://[IP]:[PORT:8841]/"
ENV NODE_ENV=production
WORKDIR /app
# npm workspaces hoist all deps into the root node_modules
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
# backups record the app version from here (lib/backup.ts appVersion)
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/dist web/dist
ENV PORT=8841 \
    UPLOADS_DIR=/data/uploads \
    WEB_DIST=/app/web/dist
RUN mkdir -p /data/uploads
VOLUME /data/uploads
EXPOSE 8841
# Deliberately root (same as our other Unraid apps): /data/uploads is a bind
# mount of /mnt/user/appdata/trboard/uploads. Docker creates a missing host dir
# as root:root 755, so a non-root user (the old `USER node`, uid 1000) got
# EACCES on every attachment upload. The app writes nothing outside /data.
CMD ["node", "server/dist/index.js"]
