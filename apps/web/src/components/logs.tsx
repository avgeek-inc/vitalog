"use client";

import { Accordion } from "@heroui/react";
import { Button } from "./ui/button";
import { Widget } from "./ui/widget";
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
    <Widget className="logs-card">
      <Widget.Header>
        <Widget.Title>
          <h2 className="font-medium">Logs</h2>
        </Widget.Title>
      </Widget.Header>
      <Widget.Content>
        {logs.length ? (
          <Accordion variant="default" className="logs-accordion">
            {logs.slice(0, visible).map((log) => {
              const kind = icons[log.type] ?? "health";
              const expandable = log.details.length > 0;
              const content = (
                <>
                  <span className="log-left">
                    <span
                      className="log-time"
                      aria-label={log.time ?? "Time not recorded"}
                    >
                      {log.time ?? "—"}
                    </span>
                    <HealthIcon kind={kind} />
                    <span className="log-name">{log.vital}</span>
                  </span>
                  <span className="log-right">
                    <span className="log-metric">{log.metric}</span>
                    <span className="log-indicator">
                      {expandable ? <Accordion.Indicator /> : null}
                    </span>
                  </span>
                </>
              );
              return (
                <Accordion.Item id={log.id} key={log.id}>
                  <Accordion.Heading>
                    {expandable ? (
                      <Accordion.Trigger className="log-trigger">
                        {content}
                      </Accordion.Trigger>
                    ) : (
                      <div className="log-trigger">{content}</div>
                    )}
                  </Accordion.Heading>
                  {expandable ? (
                    <Accordion.Panel>
                      <Accordion.Body className="log-body">
                        <dl className="log-details">
                          {log.details.map((detail, index) => (
                            <div key={index}>
                              <dt>{detail.label}</dt>
                              <dd>{detail.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </Accordion.Body>
                    </Accordion.Panel>
                  ) : null}
                </Accordion.Item>
              );
            })}
          </Accordion>
        ) : (
          <p className="empty-state">No logs for this day.</p>
        )}
        {logs.length > visible ? (
          <Button
            variant="ghost"
            className="history-more"
            onPress={() => setVisible((count) => count + 30)}
          >
            Show more
          </Button>
        ) : null}
      </Widget.Content>
    </Widget>
  );
}
