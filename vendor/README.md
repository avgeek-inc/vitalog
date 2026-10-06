# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.3 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.3](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.3), commit `7dba57ea4af87e61d91ec23ed74f8469779ce60a`.

The archive is the verified GitHub Packages registry archive from [release workflow 37539377912](https://github.com/avgeek-oss/oss-design-system/actions/runs/37539377912), with SHA-512 integrity:

```text
sha512-/kEAKNMyMlke7znDRMvX4HFXmxDnvzACto/Ea/+CQVJ6seOdWl9wzIIzRyjXb6nPFzYnf10RgE87JfvJ1evy5Q==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
