import type { Metadata } from "next";
import { WeightScreen } from "../../../components/weight-screen";
export const metadata: Metadata = { title: "Weight Management" };
export default function Weight() {
  return <WeightScreen />;
}
