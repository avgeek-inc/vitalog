# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.0 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.0](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.0), commit `4fe3c8955bfff7d3817c6f54ea31db6f3c015481`.

The archive is the verified package from [release workflow 37506803742](https://github.com/avgeek-oss/oss-design-system/actions/runs/37506803742), with SHA-512 integrity:

```text
sha512-11bnfQIw5Ep5+Dk1x5PGemRJFZ9Nc9J9DXjDyhT+pWireu9PtPh6ux4xypPYvTcriopNHxCIUjy6AGa9fcvdbg==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
