# Postman

Vitalog keeps API documentation in the repository. `collections/Vitalog API` and `environments/Vitalog.environment.yaml` use Postman's Native Git layout, matching Towbar's repository approach. `Vitalog.postman_collection.json` and `Vitalog.postman_environment.json` can also be imported into a regular Postman workspace.

Select the Vitalog environment and set `baseUrl` to the service origin, without `/v1`. Enter `authKey` as a private local secret value. The collection inherits its Bearer authentication from that variable. Never put the key in request bodies, URL parameters, exported environments or shared variable values.

Set `date` to the local calendar date being queried. Set `recordId` from a saved record's `id`. Set a fresh `idempotencyKey` for each intentional mutation and retain it for retries. The API requires that key in `Idempotency-Key` for REST and `idempotency_key` for MCP. A correction or void also needs the record's current `expected_version`; retrieve the record first.

All bodies are synthetic historical examples. Executing a logging, correction or void request changes the configured database. Use a disposable instance for exploration. The collection does not seed a database or run writes merely by being imported.

For MCP, run Initialize, then Initialized notification, then List tools. Tool calls use `POST /mcp`, `Accept: application/json, text/event-stream`, and the negotiated protocol header. Vitalog uses a fresh stateless SDK transport per HTTP request and has no persistent MCP session ID. GET with an SSE Accept header and DELETE follow the selected SDK's stateless behavior; both still require authorization. Missing/unsupported Accept or protocol headers return SDK transport errors.

The collection has 19 REST/technical requests and 19 MCP requests. The MCP group includes initialization, the initialization notification, tool listing and all sixteen tools. The REST group includes every domain route, liveness, readiness and authenticated OpenAPI.

Run `npm run docs:generate` to regenerate OpenAPI, schemas, coverage metadata and both Postman formats. `npm run docs:check` fails when a checked-in artifact is stale. The integration suite exercises the same domain schemas through HTTP and the official MCP client; a generated collection alone is not live API test evidence.
