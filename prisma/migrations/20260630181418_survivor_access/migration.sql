-- CreateTable
CREATE TABLE "SurvivorAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "survivorSalt" TEXT NOT NULL,
    "survivorAuthVerifierHash" TEXT NOT NULL,
    "escrowCiphertext" TEXT NOT NULL,
    "escrowIv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurvivorAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SurvivorAccess_userId_key" ON "SurvivorAccess"("userId");

-- AddForeignKey
ALTER TABLE "SurvivorAccess" ADD CONSTRAINT "SurvivorAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
