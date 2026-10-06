# Shared OSS components

Vitalog consumes `@avgeek-oss/design-system` 1.2.1 through its public exports. The unmodified package tarball is checked in so fresh installs and Docker builds do not require GitHub Packages credentials. Its source, declarations, Apache-2.0 license and notices are included in the archive.

Source: [Avgeek OSS Design System v1.2.1](https://github.com/avgeek-oss/oss-design-system/releases/tag/v1.2.1), commit `9999792fb0d44cf3a1b2eaacf3cf4eecdd85d544`.

The archive is the verified package from [release workflow 37524758309](https://github.com/avgeek-oss/oss-design-system/actions/runs/37524758309), with SHA-512 integrity:

```text
sha512-M3BuIAIePNMHQzfqFOWNBv/LmXwZ8UYqiXWG3g47qnKnVlTsRHEhSW4AHO/rGb1hD8i2rj0FZVO8x9o804B07A==
```

To upgrade, obtain a verified package from the intended upstream release, compare its integrity with the upstream package report, replace the archive, update the web dependency and lockfile, and verify the real app routes and production builds. Do not edit the package contents or import unpublished source paths.
