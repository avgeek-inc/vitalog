# Vitalog Mintlify site

This directory is the Mintlify monorepo content root. It follows Towbar and Mill's `mint` theme, navigation dropdowns, local brand assets and light/dark appearance. It is a documentation service, separate from the Next.js app and health API.

From the repository root:

```sh
npm run docs:generate
npm run docs:site:check
npm run docs:dev
```

The preview runs at http://localhost:4175. The Mint CLI is pinned in package scripts; it is not part of either production image.

Edit `index.mdx`, `quickstart.mdx`, `mcp-guide.mdx`, `installation.mdx`, `configuration.mdx`, `operations.mdx` and `troubleshooting.mdx` directly. The generator creates the dashboard, record, goal, API-key, OAuth and Towbar guides from their source documents in `docs/`, along with `mcp-tools.mdx`, `openapi.json` and brand assets. `npm run docs:check` detects stale output. Run `npm run docs:generate` and commit both the source and generated files after a contract change.

To publish, connect the GitHub repository `avgeek-inc/vitalog` in Mintlify, select the reviewed deployment branch and set the content directory to `docs/mintlify`. Configure the desired hostname in the Mintlify dashboard and apply its exact DNS instructions. No new UI or API workload is required in Towbar. A successful local preview does not create a hosted site or configure DNS.

After the docs hostname is serving the site over HTTPS, set `DOCS_BASE_URL` on the web service so the MCP Guide links to its `/mcp-guide` page. For Towbar, add the name to the web manifest's `secrets.runtime` list when supplying its value. Until then, the button links to the repository guide. See Mintlify's [publishing quickstart](https://www.mintlify.com/docs/quickstart) and [custom domain setup](https://www.mintlify.com/docs/customize/custom-domain) for hosting.

The API reference is generated from the same OpenAPI contract as Postman. Its playground uses simple mode with request examples; local validation does not call the production health API.
