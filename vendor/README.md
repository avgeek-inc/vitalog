# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.6 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.6](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.6), commit `acecca28fc3d121e308015ce3023527eb05a105e`.

The archive is the verified GitHub Packages registry archive from [release workflow 37638823576](https://github.com/avgeek-oss/oss-design-system/actions/runs/37638823576), with SHA-512 integrity:

```text
sha512-pJUXqlHOq6ruKOsGD0siBAbMgUGG0PxN7g+esGlCBRABV3ZVMrEDV75/4LrhbgLDYaKbiyAiFdtkKqbyjD68NA==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
