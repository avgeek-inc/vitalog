"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Account } from "../../../../src/auth/account-contracts";
const AccountContext = createContext<Account | null>(null);
export function AccountProvider({
  account,
  children,
}: {
  account: Account;
  children: ReactNode;
}) {
  return (
    <AccountContext.Provider value={account}>
      {children}
    </AccountContext.Provider>
  );
}
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error("Account provider is required");
  return account;
}
