# Boardly sync-server — standalone production image.
# better-sqlite3 ships glibc prebuilds, so a slim (non-alpine) base avoids
# needing a compiler toolchain in the image.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
# Toolchain lets node-gyp build better-sqlite3 if the prebuilt binary
# download flakes; removed again in the same layer to keep the image small.
# No lockfile is shipped with sync-server; install production deps only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev \
 && npm cache clean --force \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# DATA_DIR=/data is provided by the compose named volume; pre-create it
# owned by node so the volume initializes writable.
ENV DATA_DIR=/data \
    PORT=5400
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 5400

USER node
CMD ["node", "index.js"]
