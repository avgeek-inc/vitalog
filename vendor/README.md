# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.5 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.5](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.5), commit `523b2173c4c817e1c0d27fa6dbc98360a9e8474a`.

The archive is the verified GitHub Packages registry archive from [release workflow 37626044417](https://github.com/avgeek-oss/oss-design-system/actions/runs/37626044417), with SHA-512 integrity:

```text
sha512-38Bjes+ZJsTfjCpUu9+5zpjwBWdBgKKRdmNf3XbeaBcKOq683S2Wb9T8J84EzGsxIOaN70b6SSiuF1dBX3BbIw==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
