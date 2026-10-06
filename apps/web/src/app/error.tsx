"use client";
import { Button, Card } from "@heroui/react";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="key-page">
      <Card className="key-card key-page-content">
        <Card.Header>
          <h1 className="page-title">Vitalog is unavailable</h1>
          <Card.Description>Please try again in a moment.</Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button onPress={reset}>Try again</Button>
        </Card.Footer>
      </Card>
    </main>
  );
}
