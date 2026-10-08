"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Account } from "../../../../src/auth/account-contracts";
const AccountContext = createContext<Account | null>(null);
const UpdateAccountContext = createContext<((account: Account) => void) | null>(
  null,
);
export function AccountProvider({
  account,
  onChange,
  children,
}: {
  account: Account;
  onChange: (account: Account) => void;
  children: ReactNode;
}) {
  return (
    <AccountContext.Provider value={account}>
      <UpdateAccountContext.Provider value={onChange}>
        {children}
      </UpdateAccountContext.Provider>
    </AccountContext.Provider>
  );
}
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error("Account provider is required");
  return account;
}
export function useUpdateAccount() {
  const update = useContext(UpdateAccountContext);
  if (!update) throw new Error("Account provider is required");
  return update;
}
