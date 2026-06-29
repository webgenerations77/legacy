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
  listRecords: async (resource: string) => {
    const res = await fetch(`/api/${resource}`);
    if (!res.ok) throw new Error("We couldn't load your data.");
    return res.json() as Promise<Record<string, unknown>>;
  },
  addRecord: (resource: string, ciphertext: string, iv: string) =>
    post<{ id: string }>(`/api/${resource}`, { ciphertext, iv }),
};
