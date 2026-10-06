"use client";

import { Providers as DesignProviders } from "@avgeek-oss/design-system/utilities/providers";
import { Toast } from "@avgeek-oss/design-system/overlays/toast";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProviders>
      {children}
      <Toast.Provider placement="top" />
    </DesignProviders>
  );
}
