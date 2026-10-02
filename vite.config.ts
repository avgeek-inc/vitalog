import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web/", import.meta.url)),
  base: "/api-key-ui/",
  plugins: [tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web/", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      // HeroUI's server-component directives have no effect in this browser-only bundle.
      checks: { moduleLevelDirective: false },
    },
  },
});
