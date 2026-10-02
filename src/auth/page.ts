import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

const webRoot = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../../dist/web/" : "../../web/",
    import.meta.url,
  ),
);

export const keyPageCsp =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export function keyPage() {
  const page = new Hono();
  page.get(
    "/api-keys",
    async (c, next) => {
      c.header("Content-Security-Policy", keyPageCsp);
      c.header("Referrer-Policy", "no-referrer");
      await next();
    },
    serveStatic({ path: join(webRoot, "index.html") }),
  );
  page.get(
    "/api-key-ui/assets/:file",
    async (c, next) => {
      if (!/^[\w-]+\.(?:js|css|woff2)$/.test(c.req.param("file")))
        return c.notFound();
      await next();
    },
    serveStatic({
      root: webRoot,
      rewriteRequestPath: (path) => path.replace(/^\/api-key-ui/, ""),
    }),
  );
  return page;
}
