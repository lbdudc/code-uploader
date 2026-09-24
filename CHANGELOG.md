# Changelog

## 2.0.0

### Added
- `Uploader.deploy(config, { onEvent, signal })`: structured progress events (`step`, `log`, `services`), cancellation, and a `{ url }` result.
- Deployments finish only when all services are ready (healthchecks / one-shot services are understood), with the failing service's logs in the error.
- `normalizeConfig`: the `AWS_USERNAME`, `AWS_SSH_PRIVATE_KEY_PATH`, `REMOTE_REPO_PATH` keys the QGIS plugin sends now work.
- `projectName` option (compose project), remote path validation.
- Exports `UploadStrategy` and `CommandError` to write custom strategies.

### Changed
- Commands run without a shell (`spawn` with argv) and ssh uses `BatchMode=yes` + `StrictHostKeyChecking=accept-new`. No more Windows quoting problems or hangs on a password prompt.
- Errors are no longer swallowed: a failed `scp`, `unzip` or `docker compose` aborts the deployment. Timeouts and aborts kill the process and reject.
- One ssh connection per phase (script over stdin) instead of one per command.
- Docker is installed with the official convenience script (no deprecated `apt-key`, no hardcoded Debian release) and `docker compose` v2 is preferred over `docker-compose`.
- The package is streamed to a temp zip, excluding `node_modules`, `.git` and `.gradle`, and errors propagate.
- AWS: no redundant `StartInstances`, SSH to the public IP, waits (with retries) until sshd answers, Amazon Linux support.

### Removed
- `forceBuild` and the local client build (Docker builds it).
- `Uploader.executeCommand`, `UploadStrategy.configureInstance` / `runDockerComposeUp`.
