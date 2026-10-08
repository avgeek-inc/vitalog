"use client";
import { useAccount } from "./account-context";
import { formatDateTime } from "../lib/date-time";

import { Tooltip } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import {
  dateOffset,
  exactWeight,
  formatNumber,
  type HealthRecord,
} from "../lib/health";

export function WeightChart({
  records,
  today,
}: {
  records: HealthRecord[];
  today: string;
}) {
  const { preferences } = useAccount();
  const dateLabel = (date: string) => formatDateTime(date, preferences).date;
  const chart = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const start = dateOffset(today, -29);
  const points = records
    .filter(
      (record) =>
        record.occurred_on &&
        record.occurred_on >= start &&
        record.occurred_on <= today,
    )
    .flatMap((record) => {
      const value = exactWeight(record);
      return value === null ? [] : [{ date: record.occurred_on!, value }];
    })
    .reverse();
  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [points.length]);
  if (!points.length)
    return (
      <p className="empty-state chart-empty">
        No weigh-ins in the last 30 days.
      </p>
    );
  const height = 200,
    left = 40,
    right = 10,
    top = 16,
    bottom = 34;
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values),
    maximum = Math.max(...values);
  const pad = Math.max((maximum - minimum) * 0.1, 0.3);
  const low = Math.max(0, minimum - pad),
    high = maximum + pad;
  const x = (date: string) =>
    left +
    ((Date.parse(date) - Date.parse(start)) / (29 * 86400000)) *
      (width - left - right);
  const y = (value: number) =>
    top + ((high - value) / (high - low)) * (height - top - bottom);
  const ticks = [low, (low + high) / 2, high];
  const dates = (width < 360 ? [0, 14, 29] : [0, 7, 14, 21, 29]).map((offset) =>
    dateOffset(start, offset),
  );
  const selected = active === null ? undefined : points[active];
  const inspect = (clientX: number, clientY: number, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    const position = clientX - bounds.left;
    setCursor({ x: position, y: clientY - bounds.top });
    setActive(
      points.reduce(
        (nearest, point, index) =>
          Math.abs(x(point.date) - position) <
          Math.abs(x(points[nearest]!.date) - position)
            ? index
            : nearest,
        0,
      ),
    );
  };
  return (
    <Tooltip
      isOpen={selected !== undefined}
      delay={0}
      shouldCloseOnPress={false}
      onOpenChange={(open) => {
        if (!open) setActive(null);
      }}
    >
      <Tooltip.Trigger
        className="weight-chart-frame"
        tabIndex={0}
        role="group"
        aria-label="Weight chart. Use the left and right arrow keys to inspect weigh-ins."
        onPointerMove={(event) => {
          if (event.pointerType !== "touch")
            inspect(event.clientX, event.clientY, event.currentTarget);
        }}
        onPointerDown={(event) =>
          inspect(event.clientX, event.clientY, event.currentTarget)
        }
        onPointerLeave={(event) => {
          if (document.activeElement !== event.currentTarget) setActive(null);
        }}
        onFocus={() => {
          setCursor(null);
          setActive((index) => index ?? points.length - 1);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (
            ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            setCursor(null);
          }
          if (event.key === "ArrowLeft")
            setActive((index) => Math.max(0, (index ?? points.length - 1) - 1));
          if (event.key === "ArrowRight")
            setActive((index) =>
              Math.min(points.length - 1, (index ?? -1) + 1),
            );
          if (event.key === "Home") setActive(0);
          if (event.key === "End") setActive(points.length - 1);
          if (event.key === "Escape") setActive(null);
        }}
      >
        <svg
          ref={chart}
          className="weight-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Weight observations from ${dateLabel(start)} to ${dateLabel(today)}, in kilograms. Values are listed in Weigh-ins below.`}
        >
          {ticks.map((value) => (
            <g key={value}>
              <line
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                className="chart-grid"
              />
              <text x={left - 8} y={y(value) + 4} textAnchor="end">
                {formatNumber(value)}
              </text>
            </g>
          ))}
          <line
            x1={left}
            x2={left}
            y1={top}
            y2={height - bottom}
            className="chart-axis chart-axis-y"
          />
          <line
            x1={left}
            x2={width - right}
            y1={height - bottom}
            y2={height - bottom}
            className="chart-axis chart-axis-x"
          />
          {dates.map((date, index) => (
            <g key={date}>
              <line
                x1={x(date)}
                x2={x(date)}
                y1={height - bottom}
                y2={height - bottom + 4}
                className="chart-axis"
              />
              <text
                className="chart-date"
                x={x(date)}
                y={height - 12}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === dates.length - 1
                      ? "end"
                      : "middle"
                }
              >
                {new Intl.DateTimeFormat("en", {
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                }).format(new Date(date + "T12:00:00Z"))}
              </text>
            </g>
          ))}
          <polyline
            points={points
              .map((point) => `${x(point.date)},${y(point.value)}`)
              .join(" ")}
            className="chart-line"
          />
          {selected ? (
            <line
              x1={x(selected.date)}
              x2={x(selected.date)}
              y1={top}
              y2={height - bottom}
              className="chart-cursor"
            />
          ) : null}
          {points.map((point, index) => (
            <circle
              key={index}
              cx={x(point.date)}
              cy={y(point.value)}
              r={active === index ? 5 : 3.5}
              className="chart-point"
              data-active={active === index || undefined}
            />
          ))}
        </svg>
      </Tooltip.Trigger>
      <Tooltip.Content
        className="chart-tooltip"
        placement="top left"
        crossOffset={(cursor?.x ?? (selected ? x(selected.date) : 0)) + 12}
        offset={12 - (cursor?.y ?? (selected ? y(selected.value) : 0))}
        shouldFlip={false}
      >
        {selected ? (
          <>
            <span className="text-xs">{dateLabel(selected.date)}</span>
            <span className="font-medium">
              {formatNumber(selected.value)} kg
            </span>
          </>
        ) : null}
      </Tooltip.Content>
    </Tooltip>
  );
}
