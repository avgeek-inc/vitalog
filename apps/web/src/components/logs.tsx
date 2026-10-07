"use client";

import { ExpandableAttributeList } from "@avgeek-oss/design-system/patterns/expandable-attribute-list";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Button } from "./ui/button";
import { useState } from "react";
import type { Log } from "../lib/health";
import { HealthIcon, type HealthIconKind } from "./health-icon";

const icons: Record<string, HealthIconKind> = {
  nutrition: "nutrition",
  hydration: "water",
  measurement: "weight",
  activity: "exercise",
  sleep: "sleep",
  checkin: "mood",
  intake: "medication",
  lab_result: "health",
};
export function Logs({ logs }: { logs: Log[] }) {
  const [visible, setVisible] = useState(30);
  return (
    <ExpandableAttributeList
      title={<h2 className="font-medium">Logs</h2>}
      className="logs-card"
      footer={
        logs.length > visible ? (
          <Button
            variant="ghost"
            onPress={() => setVisible((count) => count + 30)}
          >
            Show more
          </Button>
        ) : undefined
      }
    >
      {logs.length ? (
        logs.slice(0, visible).map((log) => (
          <ExpandableAttributeList.Item
            key={log.id}
            label={log.vital}
            value={log.metric}
            leadingContent={
              <span aria-label={log.time ?? "Time not recorded"}>
                {log.time ?? "—"}
              </span>
            }
            icon={<HealthIcon kind={icons[log.type] ?? "health"} />}
          >
            {log.details.length ? (
              <Attributes variant="embedded" columns={1}>
                {log.details.map((detail, index) => (
                  <Attributes.Item key={index} label={detail.label}>
                    {detail.value}
                  </Attributes.Item>
                ))}
              </Attributes>
            ) : undefined}
          </ExpandableAttributeList.Item>
        ))
      ) : (
        <li className="col-span-full p-4 text-sm text-muted">
          No logs for this day.
        </li>
      )}
    </ExpandableAttributeList>
  );
}
