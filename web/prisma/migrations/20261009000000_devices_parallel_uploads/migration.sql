-- Desktop and mobile apps: paired devices, and parallel-chunk uploads
-- (additive: two new tables, new nullable/defaulted columns).

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "deviceId" TEXT;

-- AlterTable
ALTER TABLE "upload_sessions" ADD COLUMN     "chunkMap" BYTEA,
ADD COLUMN     "chunkSize" INTEGER,
ADD COLUMN     "clientRef" TEXT,
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'stream',
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "lastIp" TEXT,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_pairings" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "checkCode" TEXT,
    "deviceName" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "requestIp" TEXT,
    "tokenHash" TEXT,
    "deviceId" TEXT,
    "userId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_deviceId_idx" ON "sessions"("deviceId");

-- CreateIndex
CREATE INDEX "upload_sessions_deviceId_idx" ON "upload_sessions"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_userId_clientRef_key" ON "upload_sessions"("userId", "clientRef");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tokenHash_key" ON "devices"("tokenHash");

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "device_pairings_secretHash_key" ON "device_pairings"("secretHash");

-- CreateIndex
CREATE INDEX "device_pairings_expiresAt_idx" ON "device_pairings"("expiresAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
