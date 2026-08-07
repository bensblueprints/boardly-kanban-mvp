FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY scripts ./scripts
# better-sqlite3 is an optionalDependency now (the cloud image omits it) and
# publishes no musl prebuild — npm silently drops an optional package whose
# install script fails, so give node-gyp a toolchain and build it from source.
# This image is the SQLite self-host path; it genuinely needs the binding.
RUN apk add --no-cache python3 make g++
RUN npm ci --omit=dev
COPY server ./server
COPY mcp ./mcp
COPY --from=build /app/dist ./dist
ENV PORT=5315
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 5315
CMD ["node", "server/index.js"]
