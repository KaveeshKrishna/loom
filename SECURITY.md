# Security Policy

Loom manages access to your personal files — please report vulnerabilities responsibly rather than through a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Go to the **Security** tab of the repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version/commit, and steps to reproduce if possible.

This opens a private conversation with the maintainer that isn't visible publicly until it's resolved.

Please include, where relevant:
- Affected component (`web` app, `scanner`, path security / ACL logic, auth, etc.)
- Steps to reproduce, or a minimal proof of concept
- The potential impact (e.g. path traversal outside the media root, privilege escalation between Family and Owner roles, authentication bypass)

## Scope

In scope: the code in this repository (`web/`, `scanner/`, installer scripts, Dockerfiles/compose configuration) as shipped.

Out of scope: vulnerabilities in third-party dependencies (report those upstream — feel free to also flag them here if Loom's usage makes the impact worse than typical), and issues arising purely from a misconfigured deployment (e.g. deliberately exposing the container port publicly against the documented guidance in [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md)).

## Supported versions

Loom does not yet maintain multiple release branches — security fixes are made against the latest commit on `main`. If you're running an older version, please update before reporting, if practical, to confirm the issue still applies.

## Response expectations

This is a project maintained in spare time, so please allow a reasonable window for a response. Critical issues (e.g. remote path traversal, auth bypass) will be prioritized.
