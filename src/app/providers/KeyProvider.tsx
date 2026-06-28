"use client";

import { createContext, useContext, useState, ReactNode } from "react";

type KeyState = {
  masterKey: Uint8Array | null;
  setMasterKey: (k: Uint8Array | null) => void;
};

const KeyContext = createContext<KeyState | null>(null);

export function KeyProvider({ children }: { children: ReactNode }) {
  const [masterKey, setMasterKey] = useState<Uint8Array | null>(null);
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
