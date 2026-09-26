# Changelog

## 2.3.0

### Added
- `PackageStrategy`: zips the generated app (plus extra files such as a README and start scripts) instead of deploying it.
- `domain` / `acmeEmail` / `internalCertificate` config: ssh and AWS deployments answer over HTTPS at a domain. The domain is checked against the server before anything is built (only a warning for a server created by the same run), and AWS checks that the security group opens ports 80 and 443.
- ssh: a dropped connection while waiting for the stack is retried instead of failing the deploy.
- `HetznerStrategy` and `DigitalOceanStrategy` (over a shared `CloudApiStrategy`): create a server through the provider's REST API (or reuse the one with the same `serverName`), with the user's ssh key and a firewall for ports 22, 80 and 443, wait until it has a public address, then deploy over ssh as `root` exactly like the SSH strategy. Untested against the real services (a payment method is needed): covered by tests against a fake API.


## 2.2.0

### Added
- `updateData(config, opts)` (also on `Uploader`, with `describeUpdate`): loads new data into a stack that is already running by recreating only the `data-importer` service (no `down`, no build, no restart of the rest). Local and ssh/aws deployments; it fails with a clear message when the app is not deployed or not running.
- `Compose.up({ services, build })` recreates just those services (`--no-deps --force-recreate`), `Compose.waitForServices({ services })` waits only for them, and `Compose.notRunning(names)`.
- AWS: without `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the config the SDK's own credential chain is used (environment, `AWS_PROFILE`, SSO); `AWS_SESSION_TOKEN` is accepted alongside the keys.

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
