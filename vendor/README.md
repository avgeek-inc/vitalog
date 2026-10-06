# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.4 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.4](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.4), commit `caae3c47e7aa8885a2706ed9e31053c8c2bfdf5b`.

The archive is the verified GitHub Packages registry archive from [release workflow 37545712914](https://github.com/avgeek-oss/oss-design-system/actions/runs/37545712914), with SHA-512 integrity:

```text
sha512-hxzEfUW8ZwSmHlirz7o3OU4cJXhUa3EDLxpNleWW13mK8frwTBy3hAo1iInUqgw7xD9MUuAm/q/IqXjQMmFJJQ==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
