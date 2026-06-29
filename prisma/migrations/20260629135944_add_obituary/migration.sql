-- CreateTable
CREATE TABLE "Obituary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intake" JSONB NOT NULL,
    "draft" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Obituary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Obituary_userId_key" ON "Obituary"("userId");

-- AddForeignKey
ALTER TABLE "Obituary" ADD CONSTRAINT "Obituary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
