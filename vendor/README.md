# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.8 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System 1.2.8](https://github.com/avgeek-oss/oss-design-system/tree/a5d04241cff3c78c34a3e96432866f4ab8ac0bb8).

The packed archive has SHA-512 integrity:

```text
sha512-IDQiVKWdT+RL1er7xqdjQdAP7v4vr/F5O6+kYAokjg5Vks07C+AuFNl78Q+KVQmyg0E1boNre/UmoIIObHo2pg==
```

To upgrade, obtain the verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update both dependency manifests and the lockfile, and verify real app routes and production builds. Do not edit package contents or import unpublished source paths.
