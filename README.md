# Code Uploader

![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen.svg)
![npm version](https://badge.fury.io/js/code-uploader.svg)

## Description

The **Code Uploader** is a library that uploads a generated application to a machine and runs it with Docker Compose, reporting progress step by step. It has strategies for a local Docker, any SSH server (Debian/Ubuntu, and RPM based distros) and AWS EC2 instances.

## Installation

```bash
npm install @lbdudc/gp-code-uploader
```

## Pre-requisites

- [Node.js](https://nodejs.org/en/download/) 18+
- An OpenSSH client (`ssh`, `scp`) on the machine that deploys (SSH/AWS strategies)
- **Local**: Docker with the compose plugin (Docker Desktop or Docker Engine)
- **SSH**: a user with passwordless `sudo` (only needed the first time, to install Docker) and key based authentication. Password prompts are never shown: the connection fails fast instead of hanging.

## Usage

```js
import { Uploader, DebianUploadStrategy } from "@lbdudc/gp-code-uploader";

const uploader = new Uploader();
uploader.setUploadStrategy(new DebianUploadStrategy());

const { url } = await uploader.deploy(
  {
    host: "203.0.113.5",
    port: 22,
    username: "ubuntu",
    certRoute: "/home/me/.ssh/id_ed25519",
    repoPath: "./output", // generated app: must contain deploy/docker-compose.yml
    remoteRepoPath: "/home/ubuntu/app", // absolute path, wiped on every deploy
    // projectName: "my-app", // optional: compose project name (default: COMPOSE_PROJECT_NAME
    //                        // from deploy/.env, else the folder name "deploy")
  },
  {
    onEvent: (event) => console.log(event),
    // signal: abortController.signal, // cancel a running deployment
  },
);
console.log(`Deployed at ${url}`);
```

`deploy()` resolves once **every service is ready**: healthy when it has a healthcheck, running otherwise, or exited with code 0 for one-shot services (importers, init containers). If a service fails or does not get ready in 10 minutes the promise rejects with that service's last log lines.

### Strategies

| Strategy | Steps |
| --- | --- |
| `LocalUploadStrategy` | Check Docker, stop previous deployment, build & start services, wait for services |
| `DebianUploadStrategy` | Package code, connect to server, prepare server (installs Docker if missing), stop previous deployment, upload code, build & start services, wait for services |
| `AWSUploadStrategy` | *Create AWS instance* (skipped when `host` is given), then the same steps as SSH. Retries the first connection while the instance boots |

### Configuration

| Key | Used by | Description |
| --- | --- | --- |
| `repoPath` | all | Folder of the generated app (contains `deploy/docker-compose.yml`) |
| `projectName` | all | Optional compose project name (`-p`). Without it compose uses `COMPOSE_PROJECT_NAME` from `deploy/.env`, else the folder name. Set it when several apps share the same folder name |
| `resetData` | all | `true` deletes the previous deployment's volumes (`down -v`, i.e. the database) before starting. Default `false`: a redeploy keeps its data |
| `url` | all | URL returned as the result (default `http://localhost` / `http://<host>`) |
| `host`, `port`, `username`, `certRoute` | ssh, aws | SSH target and key |
| `remoteRepoPath` | ssh, aws | Absolute remote folder (validated: no `..`, spaces or quotes) |
| `AWS_*` | aws | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_AMI_ID`, `AWS_INSTANCE_TYPE`, `AWS_INSTANCE_NAME`, `AWS_SECURITY_GROUP_ID`, `AWS_KEY_NAME`. `AWS_USERNAME`, `AWS_SSH_PRIVATE_KEY_PATH` and `REMOTE_REPO_PATH` are accepted as aliases of `username`, `certRoute` and `remoteRepoPath` |

### Events

`onEvent` receives objects like:

```js
{ type: "step", id: "upload", label: "Upload code", status: "running", index: 5, total: 7 }
{ type: "step", id: "upload", label: "Upload code", status: "done", index: 5, total: 7, durationMs: 8123 }
{ type: "log", step: "build", line: "#12 [server 4/6] RUN ./gradlew build" }
{ type: "services", services: [{ name: "server", state: "running", health: "starting", status: "pending" }] }
```

`status` of a step is `running`, `done`, `skipped` or `failed`. A failed step also sets `error.step` on the rejected error. Without `onEvent`, progress is printed to the console.

### Errors

Every failure rejects `deploy()`. Errors from commands are `CommandError`s (`command`, `code`, `stderr`, `tail(n)`). Aborting the `signal` kills the running command.

## Migrating from 1.x

- `uploadCode(config)` still works (console output, resolves to the URL); prefer `deploy(config, { onEvent })`.
- `forceBuild` is **removed**: the client and server are built inside Docker, so nothing is built on the machine that deploys.
- `Uploader.executeCommand` and the strategy hooks `configureInstance` / `runDockerComposeUp` are removed.
- `docker-compose` v1 is only used as a fallback; `docker compose` is preferred.
- Commands run without a shell and with `BatchMode=yes`: a key that needs a passphrase must be loaded in an ssh-agent.
- The remote folder is emptied on every deploy, and must be an absolute path at least two levels deep.

## AWS Instance Pre-requisites

- An SSH key pair [guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-key-pairs.html)
- A security group with inbound SSH (22) and HTTP (80) [guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html)
- IAM permissions to run instances (e.g. `AmazonEC2FullAccess`) and your access/secret key [guide](https://docs.aws.amazon.com/general/latest/gr/aws-sec-cred-types.html#access-keys-and-secret-access-keys)
- An instance with enough memory: the build fails on the smallest free tier instances

## Development

```bash
npm test        # unit tests, no Docker/SSH needed
npm run lint
```

## Author

Victor Lamas
Email: <victor.lamas@udc.es>

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details
