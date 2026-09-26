FROM node:22-alpine

# ffmpeg/ffprobe for video posters and probing. sharp ships prebuilt libvips
# binaries for Alpine (x64 and arm64), so no compiler toolchain is needed.
RUN apk add --no-cache ffmpeg libc6-compat su-exec

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY tsconfig.json ./

# The scanner runs as the unprivileged "node" user (uid 1000), the same user
# as loom-web. It only needs to read /media (plus Loom's own .LoomTrash and
# .tmp-upload folders) and write /cache. The entrypoint starts as root just
# long enough to fix ownership of cache files left by older versions, then
# drops to "node" (see docker-entrypoint.sh).
RUN chown -R node:node /app
COPY docker-entrypoint.sh /usr/local/bin/loom-scanner-entrypoint
RUN chmod 755 /usr/local/bin/loom-scanner-entrypoint

ENTRYPOINT ["/usr/local/bin/loom-scanner-entrypoint"]
CMD ["npx", "tsx", "src/index.ts"]
