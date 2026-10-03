"use client";

import { Toast } from "@heroui/react";
import { useEffect, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle("dark", scheme.matches);
      document.documentElement.classList.toggle("light", !scheme.matches);
    };
    apply();
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, []);
  return (
    <>
      {children}
      <Toast.Provider />
    </>
  );
}
