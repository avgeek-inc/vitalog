"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import UtensilsCrossedIcon from "@hugeicons/core-free-icons/UtensilsCrossedIcon";
import DropletIcon from "@hugeicons/core-free-icons/DropletIcon";
import SmileIcon from "@hugeicons/core-free-icons/SmileIcon";
import FireIcon from "@hugeicons/core-free-icons/FireIcon";
import WorkoutRunIcon from "@hugeicons/core-free-icons/WorkoutRunIcon";
import WeightScaleIcon from "@hugeicons/core-free-icons/WeightScaleIcon";
import ChartLineIcon from "@hugeicons/core-free-icons/ChartLineIcon";
import SteakIcon from "@hugeicons/core-free-icons/SteakIcon";
import WheatIcon from "@hugeicons/core-free-icons/WheatIcon";
import Plant01Icon from "@hugeicons/core-free-icons/Plant01Icon";
import SleepingIcon from "@hugeicons/core-free-icons/SleepingIcon";
import PillIcon from "@hugeicons/core-free-icons/PillIcon";
import HeartCheckIcon from "@hugeicons/core-free-icons/HeartCheckIcon";
import HappyIcon from "@hugeicons/core-free-icons/HappyIcon";
import Sad02Icon from "@hugeicons/core-free-icons/Sad02Icon";
import NeutralIcon from "@hugeicons/core-free-icons/NeutralIcon";

const icons = {
  nutrition: UtensilsCrossedIcon,
  water: DropletIcon,
  mood: SmileIcon,
  calories: FireIcon,
  exercise: WorkoutRunIcon,
  weight: WeightScaleIcon,
  trend: ChartLineIcon,
  protein: SteakIcon,
  carbs: WheatIcon,
  fat: DropletIcon,
  fiber: Plant01Icon,
  sleep: SleepingIcon,
  medication: PillIcon,
  health: HeartCheckIcon,
} as const;

export type HealthIconKind = keyof typeof icons;

export function HealthIcon({
  kind,
  mood,
}: {
  kind: HealthIconKind;
  mood?: string;
}) {
  const icon =
    kind === "mood" && mood
      ? mood === "great"
        ? HappyIcon
        : mood === "good"
          ? SmileIcon
          : ["low", "very_low"].includes(mood)
            ? Sad02Icon
            : NeutralIcon
      : icons[kind];
  return (
    <HugeiconsIcon
      aria-hidden="true"
      icon={icon}
      size={16}
      className={`health-icon health-icon--${kind}`}
    />
  );
}
