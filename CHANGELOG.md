# Changelog

## 2.1.0

### Changed
- A redeploy no longer runs `docker compose down -v`: the named volumes (the database) survive. Pass `resetData: true` in the config to get the old behaviour (an empty database).
- `docker compose up` runs with `DOCKER_BUILDKIT=1` / `COMPOSE_DOCKER_CLI_BUILD=1`, so the Dockerfiles' cache mounts also work with the legacy `docker-compose` binary.
- SSH/AWS deployments upload incrementally: the server keeps a `.gp-manifest.json` (SHA-256 per file) and only new or changed files are zipped and sent; deleted files are removed and the remote folder is no longer wiped. A first deploy, or one whose manifest is missing (an interrupted upload leaves none), still sends everything.
- Already compressed files (`.zip`, `.tif`, images, jars...) are stored in the package instead of deflated again.
- The steps of an ssh/aws deploy are now: connect, prepare, package, stop, upload, build, wait (the package needs the server's manifest).

### Added
- Services labelled `gp.oneshot=true` in the compose file (the generated data importer) are pending while they run and ready once they exit 0, so the deploy only finishes after the data is loaded. Before, a running container without a healthcheck counted as ready.
- `resetData` config option, `hashFolder()` in `zipUtils`, `compressFolder({ files })`.

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
