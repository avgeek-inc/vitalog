"use client";
import { DatePicker } from "@avgeek-oss/design-system/pickers/date-picker";
import { DateField } from "@avgeek-oss/design-system/forms/date-field";
import { Calendar } from "@avgeek-oss/design-system/pickers/calendar";
import { parseDate } from "@internationalized/date";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function DayNavigation({
  date,
  today,
}: {
  date: string;
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <DatePicker
      className="w-full max-w-xs"
      aria-label="Choose date"
      value={parseDate(date)}
      maxValue={parseDate(today)}
      minValue={parseDate("0001-01-01")}
      isDisabled={pending}
      onChange={(value) => {
        if (value)
          startTransition(() =>
            router.push(
              value.toString() === today ? "/daily" : `/daily?date=${value}`,
            ),
          );
      }}
    >
      <DateField.Group variant="primary" fullWidth>
        <DateField.Input>
          {(segment) => <DateField.Segment segment={segment} />}
        </DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger aria-label="Choose date">
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover aria-label="Choose a day">
        <Calendar
          aria-label="Choose date"
          maxValue={parseDate(today)}
          minValue={parseDate("0001-01-01")}
        >
          <Calendar.Header>
            <Calendar.NavButton slot="previous" />
            <Calendar.Heading />
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
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  );
}
