# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.7 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.7](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.7), commit `e3a1b3157b132bdfcba035711acbf62f3b61cc12`.

The archive is the verified GitHub Packages registry archive from [release workflow 37650233522](https://github.com/avgeek-oss/oss-design-system/actions/runs/37650233522), with SHA-512 integrity:

```text
sha512-uvExoWKQfNMPXXWhTQDVV/aQj+O4/BUdbxQ4FOuMKhX28aI++VLQlyweOXbdLD+j+VIrcB0fFCF3gaMzRpOsnw==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
