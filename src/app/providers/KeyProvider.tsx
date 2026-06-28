"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import type { CryptoBytes } from "@/lib/crypto";

type KeyState = {
  masterKey: CryptoBytes | null;
  setMasterKey: (k: CryptoBytes | null) => void;
};

const KeyContext = createContext<KeyState | null>(null);

export function KeyProvider({ children }: { children: ReactNode }) {
  const [masterKey, setMasterKey] = useState<CryptoBytes | null>(null);
  return (
    <KeyContext.Provider value={{ masterKey, setMasterKey }}>
      {children}
    </KeyContext.Provider>
  );
}

export function useKey(): KeyState {
  const ctx = useContext(KeyContext);
  if (!ctx) throw new Error("useKey must be used within KeyProvider");
  return ctx;
}
