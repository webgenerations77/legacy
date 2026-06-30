// End-to-end walking-skeleton verification.
// Run against a LIVE dev server (npm run dev, dev database):
//   npx vitest run e2e.spec.ts
// Proves the full zero-knowledge loop: register -> unlock -> store encrypted ->
// list -> decrypt, plus that the database holds only ciphertext (never plaintext).
import { describe, it, expect, afterAll } from "vitest";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
import {
  generateSalt,
  deriveMasterKey,
  deriveAuthVerifier,
  encryptItem,
  decryptItem,
} from "@/lib/crypto";
import { serializeAccount, parseAccount, type Account } from "@/lib/account";
import { serializeBill, parseBill, type Bill } from "@/lib/bill";
import { serializeLoan, parseLoan, type Loan } from "@/lib/loan";
import {
  serializeBeneficiary,
  parseBeneficiary,
  type Beneficiary,
} from "@/lib/beneficiary";
import {
  serializeReadinessState,
  parseReadinessState,
  type ReadinessState,
} from "@/lib/readiness";
import {
  buildSurvivorEscrow,
  deriveSurvivorAuthVerifier,
  recoverMasterKey,
} from "@/lib/survivor-crypto";

const BASE = "http://localhost:3000";
// Inspect the DEV database directly (the server writes here). vitest.setup loads
// .env.test, so read the dev URL explicitly rather than from process.env.
const devUrl = config({ path: ".env" }).parsed?.DATABASE_URL as string;
const db = new PrismaClient({ datasources: { db: { url: devUrl } } });

const email = `e2e-${Date.now()}@example.com`;
const passphrase = "walkthrough-passphrase-123";
const secret = "My safe deposit box is at First National, key in the desk drawer.";

const json = { "content-type": "application/json" };

afterAll(async () => {
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

describe("walking skeleton (live)", () => {
  it("registers, unlocks, stores encrypted, and decrypts back", async () => {
    // --- Register: derive client-side, send only salt + verifier ---
    const salt = generateSalt();
    const mk = await deriveMasterKey(passphrase, salt);
    const av = await deriveAuthVerifier(mk, passphrase);
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, salt, authVerifier: av }),
    });
    expect(reg.status).toBe(201);

    // --- Fresh unlock: fetch salt, re-derive (master key never persisted) ---
    const saltRes = await fetch(`${BASE}/api/auth/salt`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email }),
    });
    expect(saltRes.status).toBe(200);
    const { salt: salt2 } = await saltRes.json();
    expect(salt2).toBe(salt);
    const mk2 = await deriveMasterKey(passphrase, salt2);
    const av2 = await deriveAuthVerifier(mk2, passphrase);

    // --- Login: get session cookie ---
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, authVerifier: av2 }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("legacy_session=");

    // --- Wrong passphrase is rejected ---
    const wrongMk = await deriveMasterKey("not-the-passphrase", salt);
    const wrongAv = await deriveAuthVerifier(wrongMk, "not-the-passphrase");
    const badLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, authVerifier: wrongAv }),
    });
    expect(badLogin.status).toBe(401);

    // --- Vault requires a session ---
    const noAuth = await fetch(`${BASE}/api/vault`);
    expect(noAuth.status).toBe(401);

    // --- Store an encrypted item ---
    const { ciphertext, iv } = await encryptItem(mk2, secret);
    const add = await fetch(`${BASE}/api/vault`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // --- List and decrypt ---
    const list = await fetch(`${BASE}/api/vault`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { items } = await list.json();
    expect(items).toHaveLength(1);
    expect(await decryptItem(mk2, items[0].ciphertext, items[0].iv)).toBe(secret);

    // --- ZERO-KNOWLEDGE: the database holds only ciphertext + a bcrypt hash ---
    const user = await db.user.findUnique({
      where: { email },
      include: { vaultItems: true },
    });
    expect(user).toBeTruthy();
    // auth verifier is stored as a bcrypt hash, not the verifier itself
    expect(user!.authVerifierHash!.startsWith("$2")).toBe(true);
    expect(user!.authVerifierHash).not.toBe(av2);
    // vault item is opaque: no plaintext anywhere
    const stored = user!.vaultItems[0];
    expect(stored.ciphertext).not.toContain("safe deposit");
    expect(stored.ciphertext).not.toContain(secret);
    // ...but it still decrypts back to the original
    expect(await decryptItem(mk2, stored.ciphertext, stored.iv)).toBe(secret);
  }, 60_000);

  it("stores and reads back an encrypted financial account", async () => {
    const aEmail = `e2e-acct-${Date.now()}@example.com`;
    const pass = "account-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: aEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: aEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store an account
    const account: Account = {
      type: "Savings",
      institution: "First National Bank",
      nickname: "Rainy day",
      accountNumber: "123456784821",
      balance: "12,500",
      notes: "Auto-pays the mortgage",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeAccount(account));
    const add = await fetch(`${BASE}/api/accounts`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/accounts`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { accounts } = await list.json();
    expect(accounts).toHaveLength(1);
    const back = parseAccount(await decryptItem(mk, accounts[0].ciphertext, accounts[0].iv));
    expect(back).toEqual(account);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: aEmail },
      include: { financialAccounts: true },
    });
    const stored = user!.financialAccounts[0];
    expect(stored.ciphertext).not.toContain("First National");
    expect(stored.ciphertext).not.toContain("123456784821");

    // cleanup
    await db.user.delete({ where: { email: aEmail } });
  }, 60_000);

  it("stores and reads back an encrypted bill", async () => {
    const bEmail = `e2e-bill-${Date.now()}@example.com`;
    const pass = "bill-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: bEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: bEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store a bill
    const billRecord: Bill = {
      name: "Northern Electric",
      category: "Utility",
      amount: "142.50",
      frequency: "Monthly",
      nextDueDate: "2026-07-01",
      paymentMethod: "Visa ••1234",
      autoPay: true,
      website: "northern-electric.example.com",
      notes: "Budget billing plan",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeBill(billRecord));
    const add = await fetch(`${BASE}/api/bills`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/bills`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { bills } = await list.json();
    expect(bills).toHaveLength(1);
    const back = parseBill(await decryptItem(mk, bills[0].ciphertext, bills[0].iv));
    expect(back).toEqual(billRecord);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: bEmail },
      include: { bills: true },
    });
    const stored = user!.bills[0];
    expect(stored.ciphertext).not.toContain("Northern Electric");
    expect(stored.ciphertext).not.toContain("142.50");

    // cleanup
    await db.user.delete({ where: { email: bEmail } });
  }, 60_000);

  it("stores and reads back an encrypted loan", async () => {
    const lEmail = `e2e-loan-${Date.now()}@example.com`;
    const pass = "loan-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: lEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: lEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store a loan
    const loanRecord: Loan = {
      kind: "Mortgage",
      lender: "First National Bank",
      nickname: "Home",
      accountNumber: "987654321098",
      originalAmount: "350,000",
      currentBalance: "312,400",
      interestRate: "6.25%",
      monthlyPayment: "2,150",
      nextPaymentDate: "2026-07-01",
      payoffDate: "2051-06-01",
      notes: "30-year fixed",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeLoan(loanRecord));
    const add = await fetch(`${BASE}/api/loans`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/loans`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { loans } = await list.json();
    expect(loans).toHaveLength(1);
    const back = parseLoan(await decryptItem(mk, loans[0].ciphertext, loans[0].iv));
    expect(back).toEqual(loanRecord);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: lEmail },
      include: { loans: true },
    });
    const stored = user!.loans[0];
    expect(stored.ciphertext).not.toContain("First National");
    expect(stored.ciphertext).not.toContain("987654321098");

    // cleanup
    await db.user.delete({ where: { email: lEmail } });
  }, 60_000);

  it("stores and reads back an encrypted beneficiary", async () => {
    const beEmail = `e2e-bene-${Date.now()}@example.com`;
    const pass = "beneficiary-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: beEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: beEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store a beneficiary
    const beneficiaryRecord: Beneficiary = {
      fullName: "Jane Doe",
      relationship: "Spouse",
      email: "jane@example.com",
      phone: "555-123-4567",
      mailingAddress: "12 Oak St, Springfield",
      allocation: "50",
      notes: "Primary beneficiary",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeBeneficiary(beneficiaryRecord));
    const add = await fetch(`${BASE}/api/beneficiaries`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/beneficiaries`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { beneficiaries } = await list.json();
    expect(beneficiaries).toHaveLength(1);
    const back = parseBeneficiary(
      await decryptItem(mk, beneficiaries[0].ciphertext, beneficiaries[0].iv),
    );
    expect(back).toEqual(beneficiaryRecord);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: beEmail },
      include: { beneficiaries: true },
    });
    const stored = user!.beneficiaries[0];
    expect(stored.ciphertext).not.toContain("Jane Doe");
    expect(stored.ciphertext).not.toContain("jane@example.com");

    // cleanup
    await db.user.delete({ where: { email: beEmail } });
  }, 60_000);

  it("lets a Google-session user set up and unlock a vault (no plaintext stored)", async () => {
    const gEmail = `e2e-google-${Date.now()}@example.com`;
    const googleId = `gid-e2e-${Date.now()}`;
    const pass = "google-vault-passphrase-123";

    // Simulate the post-Google state: a user row with googleId and no vault yet,
    // plus a live session row. (The Google OAuth dance itself can't run headless.)
    const user = await db.user.create({ data: { email: gEmail, googleId } });
    const sessionId = `e2e-sess-${Date.now()}`;
    await db.session.create({
      data: { id: sessionId, userId: user.id, expiresAt: new Date(Date.now() + 3600_000) },
    });
    const cookie = `legacy_session=${sessionId}`;

    // status → not initialized
    const s1 = await fetch(`${BASE}/api/auth/vault/status`, { headers: { cookie } });
    expect(s1.status).toBe(200);
    expect(await s1.json()).toEqual({ initialized: false });

    // a Google-only user (no vault) cannot use the email/passphrase login
    const badLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: gEmail, authVerifier: "anything" }),
    });
    expect(badLogin.status).toBe(401);

    // init the vault: derive client-side, send salt + authVerifier
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    const init = await fetch(`${BASE}/api/auth/vault/init`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ salt, authVerifier: av }),
    });
    expect(init.status).toBe(200);

    // init is one-shot: a second init is rejected
    const reinit = await fetch(`${BASE}/api/auth/vault/init`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ salt, authVerifier: av }),
    });
    expect(reinit.status).toBe(409);

    // status → initialized, returns the salt
    const s2 = await fetch(`${BASE}/api/auth/vault/status`, { headers: { cookie } });
    expect(await s2.json()).toEqual({ initialized: true, salt });

    // unlock: correct passphrase ok, wrong passphrase rejected
    const okUnlock = await fetch(`${BASE}/api/auth/vault/unlock`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ authVerifier: av }),
    });
    expect(okUnlock.status).toBe(200);
    const wrongMk = await deriveMasterKey("not-the-passphrase", salt);
    const wrongAv = await deriveAuthVerifier(wrongMk, "not-the-passphrase");
    const badUnlock = await fetch(`${BASE}/api/auth/vault/unlock`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ authVerifier: wrongAv }),
    });
    expect(badUnlock.status).toBe(401);

    // the derived key encrypts a real record through the existing record API
    const secret = "Google user's first encrypted note.";
    const enc = await encryptItem(mk, secret);
    const add = await fetch(`${BASE}/api/vault`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify(enc),
    });
    expect(add.status).toBe(201);
    const list = await fetch(`${BASE}/api/vault`, { headers: { cookie } });
    const { items } = await list.json();
    expect(await decryptItem(mk, items[0].ciphertext, items[0].iv)).toBe(secret);

    // ZERO-KNOWLEDGE: stored verifier is bcrypt, never the raw verifier or passphrase
    const stored = await db.user.findUnique({ where: { id: user.id } });
    expect(stored!.kdfSalt).toBe(salt);
    expect(stored!.authVerifierHash!.startsWith("$2")).toBe(true);
    expect(stored!.authVerifierHash).not.toBe(av);

    // cleanup
    await db.user.delete({ where: { id: user.id } });
  }, 60_000);

  it("stores and reads back the encrypted readiness acknowledgment (no plaintext)", async () => {
    const rEmail = `e2e-readiness-${Date.now()}@example.com`;
    const pass = "readiness-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: rEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: rEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // unauthenticated GET is rejected
    const noAuth = await fetch(`${BASE}/api/readiness/state`);
    expect(noAuth.status).toBe(401);

    // no state yet for this user
    const g0 = await fetch(`${BASE}/api/readiness/state`, { headers: { cookie } });
    expect(g0.status).toBe(200);
    expect(await g0.json()).toEqual({ state: null });

    // PUT an encrypted acknowledgment blob
    const state: ReadinessState = { acknowledgedEmpty: ["loans", "bills"] };
    const { ciphertext, iv } = await encryptItem(mk, serializeReadinessState(state));
    const put = await fetch(`${BASE}/api/readiness/state`, {
      method: "PUT",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(put.status).toBe(200);

    // GET returns the same blob, which decrypts back to the original state
    const g1 = await fetch(`${BASE}/api/readiness/state`, { headers: { cookie } });
    expect(g1.status).toBe(200);
    const { state: stored } = await g1.json();
    expect(stored).toBeTruthy();
    expect(
      parseReadinessState(await decryptItem(mk, stored.ciphertext, stored.iv)),
    ).toEqual(state);

    // upsert: a second PUT overwrites rather than duplicates
    const state2: ReadinessState = { acknowledgedEmpty: ["vault"] };
    const enc2 = await encryptItem(mk, serializeReadinessState(state2));
    const put2 = await fetch(`${BASE}/api/readiness/state`, {
      method: "PUT",
      headers: { ...json, cookie },
      body: JSON.stringify(enc2),
    });
    expect(put2.status).toBe(200);
    const g2 = await fetch(`${BASE}/api/readiness/state`, { headers: { cookie } });
    expect(g2.status).toBe(200);
    const { state: stored2 } = await g2.json();
    expect(
      parseReadinessState(await decryptItem(mk, stored2.ciphertext, stored2.iv)),
    ).toEqual(state2);

    // ZERO-KNOWLEDGE: the stored row holds only ciphertext — no plaintext keys
    const user = await db.user.findUnique({
      where: { email: rEmail },
      include: { readinessState: true },
    });
    expect(user!.readinessState).toBeTruthy();
    expect(user!.readinessState!.ciphertext).not.toContain("vault");
    expect(user!.readinessState!.ciphertext).not.toContain("acknowledgedEmpty");

    // cleanup
    await db.user.delete({ where: { email: rEmail } });
  }, 60_000);

  it("arms survivor access and a survivor recovers the vault (no plaintext stored)", async () => {
    const sEmail = `e2e-survivor-${Date.now()}@example.com`;
    const pass = "survivor-owner-passphrase-123";

    // register + login as owner
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, authVerifier: av }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // owner stores one encrypted beneficiary
    const bene: Beneficiary = {
      fullName: "Survivor Heir", relationship: "Child", email: "heir@example.com",
      phone: "555-9000", mailingAddress: "1 Elm St", allocation: "100", notes: "Everything",
    };
    const benBlob = await encryptItem(mk, serializeBeneficiary(bene));
    await fetch(`${BASE}/api/beneficiaries`, {
      method: "POST", headers: { ...json, cookie }, body: JSON.stringify(benBlob),
    });

    // --- ARM: wrap the master key client-side, send only salt/verifier/escrow ---
    const arm = await buildSurvivorEscrow(mk);
    const armRes = await fetch(`${BASE}/api/survivor`, {
      method: "POST", headers: { ...json, cookie },
      body: JSON.stringify({
        survivorSalt: arm.survivorSalt,
        survivorAuthVerifier: arm.survivorAuthVerifier,
        escrowCiphertext: arm.escrowCiphertext,
        escrowIv: arm.escrowIv,
      }),
    });
    expect(armRes.status).toBe(201);

    // arming requires auth
    const noAuthArm = await fetch(`${BASE}/api/survivor`, {
      method: "POST", headers: json, body: JSON.stringify({}),
    });
    expect(noAuthArm.status).toBe(401);

    // --- SURVIVOR (no session): fetch salt, derive verifier, claim ---
    const saltRes = await fetch(`${BASE}/api/survivor/salt`, {
      method: "POST", headers: json, body: JSON.stringify({ email: sEmail }),
    });
    expect(saltRes.status).toBe(200);
    const { salt: survivorSalt } = await saltRes.json();
    expect(survivorSalt).toBe(arm.survivorSalt);

    const verifier = await deriveSurvivorAuthVerifier(arm.recoveryCode, survivorSalt);

    // a wrong code is rejected with 401 — proved against a live, unconsumed escrow
    const badVerifier = await deriveSurvivorAuthVerifier("00000-00000-00000-00000", survivorSalt);
    const badClaim = await fetch(`${BASE}/api/survivor/claim`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, survivorAuthVerifier: badVerifier }),
    });
    expect(badClaim.status).toBe(401);

    const claimRes = await fetch(`${BASE}/api/survivor/claim`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, survivorAuthVerifier: verifier }),
    });
    expect(claimRes.status).toBe(200);
    const claim = await claimRes.json();

    // --- RECOVER the master key and decrypt the beneficiary ---
    const recovered = await recoverMasterKey(
      arm.recoveryCode, survivorSalt, claim.escrow.ciphertext, claim.escrow.iv,
    );
    expect(claim.records.beneficiaries).toHaveLength(1);
    const back = parseBeneficiary(
      await decryptItem(recovered, claim.records.beneficiaries[0].ciphertext,
        claim.records.beneficiaries[0].iv),
    );
    expect(back).toEqual(bene);

    // --- ZERO-KNOWLEDGE: stored survivor row holds only opaque blobs + bcrypt hash ---
    const user = await db.user.findUnique({
      where: { email: sEmail },
      include: { survivorAccess: true },
    });
    const sa = user!.survivorAccess!;
    expect(sa.survivorAuthVerifierHash.startsWith("$2")).toBe(true);
    expect(sa.survivorAuthVerifierHash).not.toBe(arm.survivorAuthVerifier);
    expect(sa.escrowCiphertext).not.toContain(arm.recoveryCode);
    // the beneficiary row itself must hold only ciphertext (not the plaintext name)
    const benRow = await db.beneficiary.findFirst({ where: { user: { email: sEmail } } });
    expect(benRow).toBeTruthy();
    expect(benRow!.ciphertext).not.toContain("Survivor Heir");

    // cleanup
    await db.user.delete({ where: { email: sEmail } });
  }, 60_000);
});
