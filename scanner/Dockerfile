FROM node:26-alpine

RUN apk add --no-cache \
    vips-dev \
    fftw-dev \
    gcc \
    g++ \
    make \
    python3 \
    libc6-compat \
    ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY tsconfig.json ./

CMD ["npx", "tsx", "src/index.ts"]
