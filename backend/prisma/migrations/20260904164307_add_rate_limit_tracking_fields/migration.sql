-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rateLimitDeferrals" INTEGER NOT NULL DEFAULT 0;
