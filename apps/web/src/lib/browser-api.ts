export function apiOrigin() {
  const value = document.querySelector<HTMLMetaElement>(
    'meta[name="vitalog-api-origin"]',
  )?.content;
  if (!value) throw new Error("API origin is unavailable");
  return value;
}

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(apiOrigin() + path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
  });
}
