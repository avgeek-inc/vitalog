"use client";

import { forwardRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "./utils";

const Root = forwardRef<HTMLDivElement, ComponentPropsWithRef<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("widget", className)}
      data-slot="widget"
      {...props}
    />
  ),
);
const Header = forwardRef<
  HTMLDivElement,
  ComponentPropsWithRef<"div"> & { endContent?: ReactNode }
>(({ children, className, endContent, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("widget__header", className)}
    data-slot="widget-header"
    {...props}
  >
    {children}
    {endContent}
  </div>
));
const Title = forwardRef<
  HTMLSpanElement,
  ComponentPropsWithRef<"span"> & { icon?: ReactNode }
>(({ children, className, icon, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      "widget__title inline-flex min-w-0 items-center gap-2 [&_svg]:size-4",
      className,
    )}
    data-slot="widget-title"
    {...props}
  >
    {icon ? (
      <span aria-hidden="true" className="inline-flex shrink-0">
        {icon}
      </span>
    ) : null}
    {children}
  </span>
));
const Content = forwardRef<HTMLDivElement, ComponentPropsWithRef<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("widget__content", className)}
      data-slot="widget-content"
      {...props}
    />
  ),
);

Root.displayName = "Widget.Root";
Header.displayName = "Widget.Header";
Title.displayName = "Widget.Title";
Content.displayName = "Widget.Content";

export const Widget = Object.assign(Root, { Root, Header, Title, Content });
