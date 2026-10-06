"use client";

import { Button } from "./ui/button";

import { Calendar, Popover, Tooltip } from "@heroui/react";
import CalendarIcon from "@gravity-ui/icons/Calendar";
import { parseDate } from "@internationalized/date";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function DayNavigation({
  date,
  today,
}: {
  date: string;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const go = (day: string) =>
    startTransition(() =>
      router.push(day === today ? "/daily" : `/daily?date=${day}`),
    );
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Tooltip isDisabled={open}>
        <Button
          variant="ghost"
          isIconOnly
          className="calendar-trigger"
          aria-label="Choose date"
          isDisabled={pending}
        >
          <CalendarIcon aria-hidden="true" />
        </Button>
        <Tooltip.Content>Choose date</Tooltip.Content>
      </Tooltip>
      <Popover.Content placement="bottom start">
        <Popover.Dialog aria-label="Choose a day">
          <Calendar
            autoFocus
            aria-label="Choose a day"
            value={parseDate(date)}
            maxValue={parseDate(today)}
            minValue={parseDate("0001-01-01")}
            isDisabled={pending}
            onChange={(value) => {
              if (
                value &&
                value.toString() <= today &&
                value.toString() >= "0001-01-01"
              ) {
                setOpen(false);
                go(value.toString());
              }
            }}
          >
            <Calendar.Header>
              <Calendar.YearPickerTrigger>
                <Calendar.YearPickerTriggerHeading />
                <Calendar.YearPickerTriggerIndicator />
              </Calendar.YearPickerTrigger>
              <Calendar.NavButton slot="previous" />
              <Calendar.NavButton slot="next" />
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(day) => <Calendar.Cell date={day} />}
              </Calendar.GridBody>
            </Calendar.Grid>
            <Calendar.YearPickerGrid>
              <Calendar.YearPickerGridBody>
                {({ year }) => <Calendar.YearPickerCell year={year} />}
              </Calendar.YearPickerGridBody>
            </Calendar.YearPickerGrid>
          </Calendar>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
