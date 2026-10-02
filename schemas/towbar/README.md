# Towbar manifest schemas

These files are unmodified copies from [Towbar v2.0.26](https://github.com/avgeek-inc/towbar/tree/8f8dac799a0551d9e53182f78dcc1f732e89586a/packages/towbar-core/schemas), commit `8f8dac799a0551d9e53182f78dcc1f732e89586a`. The upstream Apache 2.0 license is included here.

`npm run towbar:check` validates the repository and both workload files against these schemas without fetching a changing remote schema. It also checks environment references, IP targets, private network connectivity, secret declarations and the health command. Towbar performs its full cross-workload and infrastructure validation when the repository is synced.

When changing the supported Towbar version, replace all three schemas from the same reviewed upstream commit and rerun verification.
