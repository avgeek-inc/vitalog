"use client";

import { Accordion } from "@heroui/react";
import { Button } from "./ui/button";
import { Widget } from "./ui/widget";
import { useState } from "react";
import Calendar from "@gravity-ui/icons/Calendar";
import Droplet from "@gravity-ui/icons/Droplet";
import Flame from "@gravity-ui/icons/Flame";
import HeartPulse from "@gravity-ui/icons/HeartPulse";
import Pill from "@gravity-ui/icons/Pill";
import ScalesBalanced from "@gravity-ui/icons/ScalesBalanced";
import type { Log } from "../lib/health";

const icons = {
  nutrition: Flame,
  hydration: Droplet,
  measurement: ScalesBalanced,
  activity: HeartPulse,
  sleep: Calendar,
  checkin: HeartPulse,
  intake: Pill,
  lab_result: HeartPulse,
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
              const Icon = icons[log.type as keyof typeof icons] ?? HeartPulse;
              return (
                <Accordion.Item id={log.id} key={log.id}>
                  <Accordion.Heading>
                    <Accordion.Trigger className="log-trigger">
                      <span className="log-left">
                        <span
                          className="log-time"
                          aria-label={log.time ?? "Time not recorded"}
                        >
                          {log.time ?? "—"}
                        </span>
                        <Icon aria-hidden="true" />
                        <span className="log-name">{log.vital}</span>
                      </span>
                      <span className="log-right">
                        <span className="log-metric">{log.metric}</span>
                        <Accordion.Indicator />
                      </span>
                    </Accordion.Trigger>
                  </Accordion.Heading>
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
