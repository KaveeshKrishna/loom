# Security

Loom controls access to your personal files, so please report security bugs privately instead of in a public issue.

## Reporting

Use GitHub's private vulnerability reporting for this repo:

1. Go to the repo's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, which version or commit it affects, and how to reproduce it if you can.

That starts a private thread with me that stays hidden until it's fixed.

Include, if it's relevant:
- Which part is affected (`web`, `scanner`, path security / ACL, auth, and so on)
- Steps to reproduce, or a small proof of concept
- What the impact is. For example: reading files outside the media root, a Family user getting Owner access, or logging in without valid credentials.

## Scope

In scope: the code in this repo (`web/`, `scanner/`, the installer scripts, the Dockerfiles and compose config) as shipped.

Out of scope: bugs in third-party dependencies (report those upstream, though feel free to flag it here too if Loom's use of it makes things worse), and problems that only happen because of a misconfigured setup, like exposing the container port to the internet when [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md) says not to.

## Versions

There's only one line of development right now. Security fixes go on the latest `main`. If you're on an older version, update first if you can, to check the bug is still there.

## Response time

This is a spare-time project, so give me a reasonable amount of time to reply. Serious bugs like remote path traversal or auth bypass come first.
