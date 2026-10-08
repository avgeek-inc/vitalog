# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.10 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System 1.2.10](https://github.com/avgeek-oss/oss-design-system/tree/v1.2.10).

The packed archive has SHA-512 integrity:

```text
sha512-HkU7ZRksFQy9jql97RpJGZRoe2c5eMvjHFc4j8MfxbXEhlINJtM72yGw9J28blcXmv0lMxrijI9YLfXrkHQyHQ==
```

To upgrade, obtain the verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update both dependency manifests and the lockfile, and verify real app routes and production builds. Do not edit package contents or import unpublished source paths.
