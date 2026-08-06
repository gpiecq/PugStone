-- CreateEnum
CREATE TYPE "GuildStatus" AS ENUM ('ACTIVE', 'NEEDS_ATTENTION', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('NORMAL', 'HEROIC', 'MYTHIC');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('OPEN', 'FILLED');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "WowRole" AS ENUM ('TANK', 'HEALER', 'DPS');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('PUBLIC', 'DASHBOARD');

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "discordGuildId" TEXT NOT NULL,
    "lfgChannelId" TEXT,
    "recruiterRoleIds" TEXT[],
    "timezone" TEXT NOT NULL,
    "status" "GuildStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCode" (
    "code" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "usedByGuild" TEXT,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "originGuildId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorContact" TEXT NOT NULL DEFAULT '',
    "raidName" TEXT NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "publicVersion" INTEGER NOT NULL DEFAULT 0,
    "dashboardVersion" INTEGER NOT NULL DEFAULT 0,
    "dashboardChannelId" TEXT,
    "dashboardMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Slot" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "specName" TEXT NOT NULL,
    "role" "WowRole" NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedApplicationId" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "applicantTag" TEXT NOT NULL,
    "ignRealm" TEXT NOT NULL,
    "itemLevel" INTEGER NOT NULL,
    "logsUrl" TEXT NOT NULL,
    "comment" TEXT,
    "status" "AppStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMessage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" "MessageKind" NOT NULL,
    "syncedVersion" INTEGER NOT NULL DEFAULT -1,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "EventMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guild_discordGuildId_key" ON "Guild"("discordGuildId");

-- CreateIndex
CREATE INDEX "Guild_status_idx" ON "Guild"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_usedByGuild_key" ON "InviteCode"("usedByGuild");

-- CreateIndex
CREATE INDEX "Event_status_scheduledAt_idx" ON "Event"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Slot_acceptedApplicationId_key" ON "Slot"("acceptedApplicationId");

-- CreateIndex
CREATE INDEX "Slot_eventId_idx" ON "Slot"("eventId");

-- CreateIndex
CREATE INDEX "Application_slotId_status_idx" ON "Application"("slotId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Application_slotId_applicantId_key" ON "Application"("slotId", "applicantId");

-- CreateIndex
CREATE INDEX "EventMessage_disabled_nextAttemptAt_idx" ON "EventMessage"("disabled", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventMessage_eventId_guildId_kind_key" ON "EventMessage"("eventId", "guildId", "kind");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_usedByGuild_fkey" FOREIGN KEY ("usedByGuild") REFERENCES "Guild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_originGuildId_fkey" FOREIGN KEY ("originGuildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "Slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMessage" ADD CONSTRAINT "EventMessage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
