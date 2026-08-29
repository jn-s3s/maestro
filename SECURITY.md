# Security Policy

Thank you for helping keep Maestro and its users safe.

## Supported versions

Only the latest release receives security fixes. If you are running an older build, please update before reporting an issue.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## How to report a vulnerability

Please use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/jn-s3s/maestro/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the steps to reproduce it and the impact you believe it has.

If private reporting is unavailable for any reason, open a minimal public issue asking for a private contact channel without revealing details.

## What to include

- The Maestro version affected (the portable exe filename includes it)
- Steps or proof of concept showing how the issue manifests
- Which component is involved if you know it (main process IPC, backups, registry, preload bridge)

## What to expect

You will receive an acknowledgment as soon as the report is triaged. Fixes are developed privately where possible and released together with a patched version. You will be credited in the release notes unless you prefer to stay anonymous.

Please do not disclose the issue publicly until a fix has been released.

## Scope notes

Maestro reads and writes AI agent configuration files on disk, some of which contain secrets (API keys, OAuth tokens). Reports involving exfiltration of those files beyond what the app legitimately does, injection through custom entries, or unsafe path handling in the IPC surface are all in scope.
