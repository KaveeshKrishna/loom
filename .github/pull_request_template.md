## What does this change?

<!-- A sentence or two on what changed and why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / cleanup (no behavior change)
- [ ] Schema migration (put the name below)

## Checklist

- [ ] `docker compose build loom-web loom-scanner` passes locally
- [ ] If `web/prisma/schema.prisma` changed, `scanner/prisma/schema.prisma` matches it (`./scripts/sync-schema.sh --fix`) and there's a migration
- [ ] I've read [CONTRIBUTING.md](../CONTRIBUTING.md), including what the license means for contributions

## Migration name (if any)

<!-- e.g. 20260115_add_favorites_index -->

## Notes for reviewers

<!-- Anything that needs a closer look: filesystem operations, path validation, auth/ACL changes, and so on. -->
