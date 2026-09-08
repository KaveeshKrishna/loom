## What does this change?

<!-- One or two sentences on what changed and why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / cleanup (no behavior change)
- [ ] Schema migration (mention the migration name below)

## Checklist

- [ ] `docker compose build loom-web loom-scanner` succeeds locally
- [ ] If `web/prisma/schema.prisma` changed, `scanner/prisma/schema.prisma` was updated to match (`./scripts/sync-schema.sh --fix`) and a migration was generated
- [ ] I've read [CONTRIBUTING.md](../CONTRIBUTING.md), including the license implication for contributions

## Migration name (if applicable)

<!-- e.g. 20260115_add_favorites_index -->

## Notes for reviewers

<!-- Anything that needs extra scrutiny — filesystem operations, path validation, auth/ACL changes, etc. -->
