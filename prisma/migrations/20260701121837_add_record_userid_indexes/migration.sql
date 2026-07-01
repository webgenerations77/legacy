-- CreateIndex
CREATE INDEX "Beneficiary_userId_idx" ON "Beneficiary"("userId");

-- CreateIndex
CREATE INDEX "Bill_userId_idx" ON "Bill"("userId");

-- CreateIndex
CREATE INDEX "Document_userId_idx" ON "Document"("userId");

-- CreateIndex
CREATE INDEX "FinancialAccount_userId_idx" ON "FinancialAccount"("userId");

-- CreateIndex
CREATE INDEX "Loan_userId_idx" ON "Loan"("userId");

-- CreateIndex
CREATE INDEX "VaultItem_userId_idx" ON "VaultItem"("userId");
