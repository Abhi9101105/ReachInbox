-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "previewUrl" TEXT,
ADD COLUMN     "providerMessageId" TEXT;
