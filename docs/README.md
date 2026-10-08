# Vitalog Mintlify site

This directory is the Mintlify monorepo content root. It follows Towbar and Mill's `mint` theme, navigation dropdowns, local brand assets and light/dark appearance. It is a documentation service, separate from the Next.js app and health API.

From the repository root:

```sh
npm run docs:generate
npm run docs:site:check
npm run docs:dev
```

The preview runs at http://localhost:4175. The Mint CLI is pinned in package scripts; it is not part of either production image.

Edit `site.json` for branding and navigation. The pinned `@avgeek-oss/docs` package generates `docs.json`, `oss-docs.css`, `oss-docs.js` and `snippets/oss/`; commit these generated outputs and never hand-edit them.

Edit `index.mdx`, `concepts.mdx`, `logging.mdx`, `contributing.mdx`, `quickstart.mdx`, `mcp-guide.mdx`, `installation.mdx`, `configuration.mdx`, `operations.mdx` and `troubleshooting.mdx` directly. The generator creates the dashboard, record, goal, API-key, OAuth and Towbar guides from their source documents in `docs/`, along with `mcp-tools.mdx`, `openapi.json` and brand assets. `npm run docs:check` detects stale output. Run `npm run docs:generate` and commit both the source and generated files after a contract change.

Markdown source guides and generated contract reports remain in this directory for repository contributors. `.mintignore` excludes them from publishing; visitors see only the public MDX guides and the API reference.

## Hosting

The public site uses `https://www.vitalog.dev`, with `vitalog.dev` redirecting to the same content. Connect the GitHub repository `avgeek-oss/vitalog` in Mintlify, select `main`, and set the content directory to `docs`. Configure the custom hostname and apply the exact records shown by Mintlify. No UI or API workload is required in Towbar. See [custom domains](https://www.mintlify.com/docs/settings/custom-domain).

The web app's Documentation and MCP Guide links default to this public site. `DOCS_BASE_URL` optionally overrides the origin for a fork; declare the name in your web runtime secrets when using an override. This hostname is for documentation only, never a health API or sign-in endpoint.

## Screenshots

The homepage and dashboard guide reuse one light/dark Daily View pair. Both contain synthetic observations from `scripts/web-verification.ts`, a disposable PostgreSQL database and `root@example.test`. They do not contain production records, tokens or real account details.

To refresh them, run `npm run preview:web` in one terminal and `npm run docs:screenshots` in another. The capture script signs in only to the loopback fixture with `root@example.test`, renders the real dashboard at a 1280 × 824 CSS-pixel viewport with a 2× device scale, and writes lossless 2560 × 1648 PNGs to `assets/`. Run `npm run docs:generate` after a refresh, then stop the preview to remove the disposable database. Keep generated credentials and preview metadata out of Git.

The API reference is generated from the same OpenAPI contract as Postman. Its playground uses simple mode with request examples; local validation does not call the production health API.
