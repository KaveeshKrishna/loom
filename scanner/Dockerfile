FROM node:22-alpine

# ffmpeg/ffprobe for video posters and probing. sharp ships prebuilt libvips
# binaries for Alpine (x64 and arm64), so no compiler toolchain is needed.
RUN apk add --no-cache ffmpeg libc6-compat

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY tsconfig.json ./

# Run as the unprivileged "node" user (uid 1000), the same user as loom-web.
# The scanner only needs to read /media (plus Loom's own .LoomTrash and
# .tmp-upload folders) and write /cache.
RUN chown -R node:node /app
USER node

CMD ["npx", "tsx", "src/index.ts"]
