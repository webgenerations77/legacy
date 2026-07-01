import { type ObituaryIntake } from "@/lib/obituary";

export type SurvivorBlob = { id: string; ciphertext: string; iv: string };
export type DocumentMetaRow = { id: string; metaCiphertext: string; metaIv: string };
export type SurvivorRecords = {
  items: SurvivorBlob[];
  accounts: SurvivorBlob[];
  bills: SurvivorBlob[];
  loans: SurvivorBlob[];
  beneficiaries: SurvivorBlob[];
  documents: DocumentMetaRow[];
  obituary: { intake: ObituaryIntake; draft: string } | null;
};
export type SurvivorClaim = {
  escrow: { ciphertext: string; iv: string };
  records: SurvivorRecords;
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  register: (email: string, salt: string, authVerifier: string) =>
    post<{ ok: true }>("/api/auth/register", { email, salt, authVerifier }),
  getSalt: (email: string) =>
    post<{ salt: string }>("/api/auth/salt", { email }),
  login: (email: string, authVerifier: string) =>
    post<{ ok: true }>("/api/auth/login", { email, authVerifier }),
  logout: () => post<{ ok: true }>("/api/auth/logout", {}),
  vaultStatus: async () => {
    const res = await fetch("/api/auth/vault/status");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("We couldn't check your vault status.");
    return res.json() as Promise<{ initialized: boolean; salt?: string }>;
  },
  vaultInit: (salt: string, authVerifier: string) =>
    post<{ ok: true }>("/api/auth/vault/init", { salt, authVerifier }),
  vaultUnlock: (authVerifier: string) =>
    post<{ ok: true }>("/api/auth/vault/unlock", { authVerifier }),
  accountStatus: async () => {
    const res = await fetch("/api/account/status");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("We couldn't load your account.");
    return res.json() as Promise<{ email: string; googleLinked: boolean; hasPassword: boolean }>;
  },
  pendingLink: async () => {
    const res = await fetch("/api/auth/google/pending");
    if (!res.ok) return { email: null as string | null };
    return res.json() as Promise<{ email: string | null }>;
  },
  googleLink: (authVerifier: string) =>
    post<{ ok: true }>("/api/auth/google/link", { authVerifier }),
  googleUnlink: (authVerifier: string) =>
    post<{ ok: true }>("/api/auth/google/unlink", { authVerifier }),
  listRecords: async (resource: string) => {
    const res = await fetch(`/api/${resource}`);
    if (!res.ok) throw new Error("We couldn't load your data.");
    return res.json() as Promise<Record<string, unknown>>;
  },
  addRecord: (resource: string, ciphertext: string, iv: string) =>
    post<{ id: string }>(`/api/${resource}`, { ciphertext, iv }),
  updateRecord: async (resource: string, id: string, ciphertext: string, iv: string) => {
    const res = await fetch(`/api/${resource}/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertext, iv }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
  deleteRecord: async (resource: string, id: string) => {
    const res = await fetch(`/api/${resource}/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
  getObituary: async () => {
    const res = await fetch("/api/obituary");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("We couldn't load your obituary.");
    return res.json() as Promise<{
      obituary: { intake: ObituaryIntake; draft: string } | null;
    }>;
  },
  saveObituary: async (intake: ObituaryIntake, draft: string) => {
    const res = await fetch("/api/obituary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intake, draft }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
  getReadinessState: async () => {
    const res = await fetch("/api/readiness/state");
    if (res.status === 401) return { state: null };
    if (!res.ok) throw new Error("We couldn't load your readiness data.");
    return res.json() as Promise<{
      state: { ciphertext: string; iv: string } | null;
    }>;
  },
  putReadinessState: async (ciphertext: string, iv: string) => {
    const res = await fetch("/api/readiness/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertext, iv }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
  survivorStatus: async () => {
    const res = await fetch("/api/survivor");
    if (res.status === 401) return { armed: false, updatedAt: null };
    if (!res.ok) throw new Error("We couldn't check survivor access.");
    return res.json() as Promise<{ armed: boolean; updatedAt: string | null }>;
  },
  armSurvivor: (payload: {
    survivorSalt: string;
    survivorAuthVerifier: string;
    escrowCiphertext: string;
    escrowIv: string;
  }) => post<{ ok: true }>("/api/survivor", payload),
  revokeSurvivor: async () => {
    const res = await fetch("/api/survivor", { method: "DELETE" });
    if (!res.ok) throw new Error("We couldn't remove survivor access.");
    return res.json() as Promise<{ ok: true }>;
  },
  survivorSalt: (email: string) =>
    post<{ salt: string }>("/api/survivor/salt", { email }),
  survivorClaim: (email: string, survivorAuthVerifier: string) =>
    post<SurvivorClaim>("/api/survivor/claim", { email, survivorAuthVerifier }),
  listDocuments: async () => {
    const res = await fetch("/api/documents");
    if (!res.ok) throw new Error("We couldn't load your documents.");
    return res.json() as Promise<{ documents: DocumentMetaRow[] }>;
  },
  addDocument: (p: {
    metaCiphertext: string;
    metaIv: string;
    contentCiphertext: string;
    contentIv: string;
  }) => post<{ id: string }>("/api/documents", p),
  getDocumentContent: async (id: string) => {
    const res = await fetch(`/api/documents/${id}`);
    if (!res.ok) throw new Error("We couldn't open that file.");
    return res.json() as Promise<{ contentCiphertext: string; contentIv: string }>;
  },
  deleteDocument: async (id: string) => {
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
  survivorDocument: (email: string, survivorAuthVerifier: string, documentId: string) =>
    post<{ contentCiphertext: string; contentIv: string }>("/api/survivor/document", {
      email,
      survivorAuthVerifier,
      documentId,
    }),
};
