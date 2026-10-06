"use client";
import { Button, Card } from "@heroui/react";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <Card className="data-error">
      <Card.Header>
        <h1 className="page-title">Unable to load your records</h1>
        <Card.Description>Please try again in a moment.</Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button onPress={reset}>Try again</Button>
      </Card.Footer>
    </Card>
  );
}
