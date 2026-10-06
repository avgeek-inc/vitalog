"use client";

// Adapted from Towbar and Mill's Apache-2.0 application shell. See NOTICE.md.
import { Drawer, Tooltip } from "@heroui/react";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button } from "./button";
import { cn } from "./utils";

const desktopQuery = "(min-width: 64rem)";
const subscribeToViewport = (callback: () => void) => {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};
const isDesktopViewport = () => window.matchMedia(desktopQuery).matches;
const serverViewport = () => false;
const storageKey = "vitalog:sidebar-open";
const storageEvent = "vitalog:sidebar-change";
const subscribeToStorage = (callback: () => void) => {
  window.addEventListener("storage", callback);
  window.addEventListener(storageEvent, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(storageEvent, callback);
  };
};
const savedSidebarOpen = () => {
  try {
    return window.localStorage.getItem(storageKey) !== "false";
  } catch {
    return true;
  }
};

export function usePersistentAppSidebar() {
  const isDesktop = useSyncExternalStore(
    subscribeToViewport,
    isDesktopViewport,
    serverViewport,
  );
  const savedOpen = useSyncExternalStore(
    subscribeToStorage,
    savedSidebarOpen,
    () => true,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [temporaryOpen, setTemporaryOpen] = useState<boolean>();
  useEffect(() => {
    setMobileOpen(false);
  }, [isDesktop]);
  const onSidebarOpenChange = useCallback((open: boolean) => {
    if (!isDesktopViewport()) {
      setMobileOpen(open);
      return;
    }
    setTemporaryOpen(open);
    try {
      window.localStorage.setItem(storageKey, String(open));
      window.dispatchEvent(new Event(storageEvent));
      setTemporaryOpen(undefined);
    } catch {
      // Keep navigation available when browser storage is unavailable.
    }
  }, []);
  return {
    isDesktop,
    sidebarOpen: isDesktop ? (temporaryOpen ?? savedOpen) : mobileOpen,
    onSidebarOpenChange,
  };
}

const NavigationContext = createContext<{
  path: string;
  navigate: (href: string) => void;
  close: () => void;
}>({ path: "/", navigate: () => {}, close: () => {} });

export function AppLayout({
  children,
  navbar,
  sidebar,
  path,
  navigate,
  isDesktop,
  sidebarOpen,
  onSidebarOpenChange,
}: {
  children: ReactNode;
  navbar: ReactNode;
  sidebar: ReactNode;
  path: string;
  navigate: (href: string) => void;
  isDesktop: boolean;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
}) {
  const previousPath = useRef(path);
  const layout = useRef<HTMLDivElement>(null);
  const desktopSidebar = useRef<HTMLElement>(null);
  const focusToggle = useCallback(() => {
    layout.current
      ?.querySelector<HTMLButtonElement>(".navigation-toggle")
      ?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (
      isDesktop &&
      !sidebarOpen &&
      desktopSidebar.current?.contains(document.activeElement)
    )
      focusToggle();
  }, [focusToggle, isDesktop, sidebarOpen]);
  useEffect(() => {
    const changed = previousPath.current !== path;
    previousPath.current = path;
    if (changed && !isDesktopViewport()) onSidebarOpenChange(false);
  }, [onSidebarOpenChange, path]);
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSidebarOpenChange(!sidebarOpen);
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [onSidebarOpenChange, sidebarOpen]);
  return (
    <NavigationContext.Provider
      value={{
        path,
        navigate,
        close: () => {
          if (!isDesktopViewport()) onSidebarOpenChange(false);
        },
      }}
    >
      <div
        ref={layout}
        className="application-layout min-h-dvh"
        data-sidebar-open={isDesktop && sidebarOpen}
        data-has-sidebar={isDesktop}
      >
        {isDesktop ? (
          <div className="application-sidebar sticky top-0 h-dvh min-w-0 overflow-hidden">
            <aside
              ref={desktopSidebar}
              id="application-navigation"
              aria-hidden={!sidebarOpen}
              inert={!sidebarOpen}
              className="application-sidebar-panel h-full w-60 overflow-hidden border-r border-separator bg-background"
            >
              {sidebar}
            </aside>
          </div>
        ) : null}
        <div className="grid min-h-dvh min-w-0 grid-cols-1 grid-rows-[auto_1fr]">
          {navbar}
          <main
            id="main-content"
            className="min-w-0 outline-none"
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      </div>
      <Drawer.Backdrop
        isOpen={sidebarOpen && !isDesktop}
        onOpenChange={onSidebarOpenChange}
      >
        <Drawer.Content placement="left">
          <Drawer.Dialog
            id="application-navigation"
            aria-label="Navigation"
            className="application-navigation-drawer max-w-[calc(100vw-1rem)] overflow-hidden bg-background p-0"
          >
            <div
              className="relative h-full min-h-0 min-w-0"
              data-slot="drawer-body"
            >
              {sidebar}
              <Drawer.CloseTrigger
                autoFocus
                aria-label="Close navigation"
                className="end-3 top-2.5 size-11 bg-transparent hover:bg-transparent"
              />
            </div>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </NavigationContext.Provider>
  );
}

type ShellLink = { id: string; href: string; label: string; icon?: ReactNode };
export type SidebarConfig = {
  accessibleLabel: string;
  brand: { title: string; logo: ReactNode };
  homeHref: string;
  groups: { id: string; label: string; items: ShellLink[] }[];
  footerContent?: ReactNode;
};

function RoutedLink({
  item,
  className,
  children,
}: {
  item: ShellLink;
  className?: string;
  children?: ReactNode;
}) {
  const { path, navigate, close } = useContext(NavigationContext);
  function click(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(item.href);
    close();
  }
  return (
    <a
      href={item.href}
      onClick={click}
      className={className}
      aria-current={path === item.href ? "page" : undefined}
    >
      {children ?? item.label}
    </a>
  );
}

export function ApplicationSidebar({ config }: { config: SidebarConfig }) {
  const { path } = useContext(NavigationContext);
  return (
    <nav
      aria-label={config.accessibleLabel}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <RoutedLink
        item={{ id: "home", href: config.homeHref, label: config.brand.title }}
        className="inline-flex min-h-16 min-w-0 shrink-0 items-center gap-2.5 border-b border-separator px-4"
      >
        <span
          aria-hidden="true"
          className="inline-grid size-8 shrink-0 place-items-center"
        >
          {config.brand.logo}
        </span>
        <span className="truncate text-base font-medium">
          {config.brand.title}
        </span>
      </RoutedLink>
      <div className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto overscroll-contain px-3 py-4.5">
        {config.groups.map((group) => (
          <section className="grid gap-1 [&+&]:mt-2" key={group.id}>
            <h2 className="px-2 py-1.5 text-xs font-medium text-muted">
              {group.label}
            </h2>
            <div className="grid gap-0.5">
              {group.items.map((item) => (
                <RoutedLink
                  key={item.id}
                  item={item}
                  className={cn(
                    "sidebar-link flex min-h-9 min-w-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:min-h-11",
                    path === item.href
                      ? "font-medium"
                      : "font-normal text-muted hover:bg-default/60 hover:text-foreground",
                  )}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </RoutedLink>
              ))}
            </div>
          </section>
        ))}
      </div>
      {config.footerContent ? (
        <div className="shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {config.footerContent}
        </div>
      ) : null}
    </nav>
  );
}

export function ApplicationNavbar({
  title,
  sidebarOpen,
  onSidebarToggle,
}: {
  title: ReactNode;
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center gap-2 border-b border-separator bg-background/90 pl-2 pr-4 backdrop-blur">
      <Tooltip>
        <Button
          aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={sidebarOpen}
          aria-controls={sidebarOpen ? "application-navigation" : undefined}
          className="navigation-toggle relative size-8 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
          isIconOnly
          variant="ghost"
          onPress={onSidebarToggle}
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={Menu01Icon}
            className="size-4"
          />
        </Button>
        <Tooltip.Content>Toggle navigation</Tooltip.Content>
      </Tooltip>
      <div className="min-w-0 truncate text-sm font-medium">{title}</div>
    </header>
  );
}
