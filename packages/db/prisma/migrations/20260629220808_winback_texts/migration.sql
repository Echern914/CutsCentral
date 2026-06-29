-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "winbackTemplate" TEXT,
ADD COLUMN     "winbackTextsEnabled" BOOLEAN NOT NULL DEFAULT false;
