"use client";
import { BackendRecovery } from "../components/backend-recovery";
export default function Error({ retry }: { retry: () => void }) {
  return <BackendRecovery retry={retry} />;
}
