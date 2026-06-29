-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleId" TEXT,
ALTER COLUMN "kdfSalt" DROP NOT NULL,
ALTER COLUMN "authVerifierHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
