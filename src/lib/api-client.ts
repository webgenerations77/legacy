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
  listVault: async () => {
    const res = await fetch("/api/vault");
    if (!res.ok) throw new Error("Could not load your vault.");
    return res.json() as Promise<{ items: { id: string; ciphertext: string; iv: string }[] }>;
  },
  addVaultItem: (ciphertext: string, iv: string) =>
    post<{ id: string }>("/api/vault", { ciphertext, iv }),
  listAccounts: async () => {
    const res = await fetch("/api/accounts");
    if (!res.ok) throw new Error("We couldn't load your accounts.");
    return res.json() as Promise<{
      accounts: { id: string; ciphertext: string; iv: string }[];
    }>;
  },
  addAccount: (ciphertext: string, iv: string) =>
    post<{ id: string }>("/api/accounts", { ciphertext, iv }),
};
