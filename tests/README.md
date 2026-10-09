# Tests

Integration tests that run against a real, disposable Loom built from this checkout. They never touch an existing installation: the stack has its own compose project (`loomtest`), database, ports and media folder, and reads nothing from the repo's `.env`.

## Running them

```bash
tests/stack/stack.sh up          # build and start the test Loom (first build takes a few minutes)
cd tests && npm ci && npm run api
tests/stack/stack.sh down        # stop it and delete its data
```

Run against a fresh stack (`tests/stack/stack.sh reset`). The tests create the Owner through first-run setup, and some rate limits are counted per process, so a second run against the same stack can trip them.

| Variable | Default | What |
|---|---|---|
| `LOOM_TEST_DIR` | `~/.cache/loomtest` | Media, cache and the LAN test CA. `down` only deletes a folder that `up` created. |
| `LOOM_TEST_PORT` | `18085` | loom-web |
| `LOOM_TEST_LAN_PORT` | `18443` | loom-lan (HTTPS, app tokens only) |
| `LOOM_TEST_PG_PORT` | `18432` | Postgres, for time travel in the tests |

The stack uses 1 MiB upload chunks and a 64 MiB write window, so multi-chunk paths and limits are reached with small files.

## What's covered

- `api/devices.test.ts`: pairing (approve and QR flows, token commitment, expiry, declines), bearer tokens and what they may not do, the Devices list, removal, password resets, and signing an app's browser in.
- `api/uploads.test.ts`: the browser's in-order protocol (unchanged behaviour), the apps' numbered parallel chunks (out of order, duplicates, checksums, write window, caps, aborts, a server restart), who sees which unfinished uploads, expiry and housekeeping.
- `api/lan.test.ts`: `/api/client/info`, and the LAN listener's certificate, app-only access and uploads.
