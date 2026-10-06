import type { ReactNode } from "react";

export function PageHeading({
  title,
  icon,
  actions,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="py-5">
      <header className="flex flex-wrap items-center justify-between gap-5">
        <h1 className="flex min-w-0 items-center gap-2 text-xl font-medium">
          {icon ? (
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 [&_svg]:size-5"
            >
              {icon}
            </span>
          ) : null}
          {title}
        </h1>
        {actions}
      </header>
    </div>
  );
}
