import os from "os";
import fs from "fs";
import path from "path";
import UploadStrategy from "./UploadStrategy.js";
import { SSHClient } from "../ssh.js";
import { assertRemoteConfig } from "../config.js";
import { compressFolder } from "../utils/zipUtils.js";
import { getAbsolutePath, shQuote, formatDuration } from "../utils/utils.js";
import { Compose } from "../docker/compose.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exit sudo early with a readable message instead of hanging on a prompt. */
const REQUIRE_SUDO = `sudo -n true 2>/dev/null || { echo "Passwordless sudo is required on the server to install Docker" >&2; exit 1; }`;

export const CHECK_DOCKER_SCRIPT = `if command -v docker >/dev/null 2>&1 && { docker compose version >/dev/null 2>&1 || sudo -n docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1 || sudo -n docker-compose version >/dev/null 2>&1; }; then echo READY; else echo MISSING; fi`;

export const PROVISION_SCRIPT = `${REQUIRE_SUDO}
if command -v apt-get >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates; }
  curl -fsSL https://get.docker.com | sudo sh
else
  if command -v dnf >/dev/null 2>&1; then sudo dnf install -y docker; else sudo yum install -y docker; fi
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -fSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || sudo service docker start
sudo usermod -aG docker "$USER" || true`;

const INSTALL_UNZIP = `command -v unzip >/dev/null 2>&1 || {
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y -qq unzip;
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y unzip;
  else sudo yum install -y unzip; fi
}`;

/**
 * Deploys over ssh to a Linux machine with Docker (installed on demand).
 * Concrete strategies (Debian/Ubuntu, AWS) extend it.
 */
class RemoteStrategy extends UploadStrategy {
  constructor({ sshFactory, sleepFn = sleep } = {}) {
    super();
    this._sshFactory = sshFactory || ((opts) => new SSHClient(opts));
    this._sleep = sleepFn;
  }

  /** Steps that run before the ssh ones (e.g. creating an EC2 instance). */
  preSteps() {
    return [];
  }

  /** How many times to retry the first connection (a fresh VM boots slowly). */
  connectRetries() {
    return 0;
  }

  plan() {
    return [
      ...this.preSteps(),
      {
        id: "package",
        label: "Package code",
        run: (ctx) => this._package(ctx),
      },
      {
        id: "connect",
        label: "Connect to server",
        run: (ctx) => this._connect(ctx),
      },
      {
        id: "prepare",
        label: "Prepare server",
        run: (ctx) => this._prepare(ctx),
      },
      {
        id: "stop",
        label: "Stop previous deployment",
        run: (ctx) => this._stopPrevious(ctx),
      },
      { id: "upload", label: "Upload code", run: (ctx) => this._upload(ctx) },
      {
        id: "build",
        label: "Build & start services",
        run: (ctx) => this._up(ctx),
      },
      { id: "wait", label: "Wait for services", run: (ctx) => this._wait(ctx) },
    ];
  }

  resolveUrl(config, state) {
    return config.url || `http://${state.host || config.host}`;
  }

  _ssh(ctx) {
    if (!ctx.state.ssh) {
      const { config } = ctx;
      assertRemoteConfig({ ...config, host: ctx.state.host || config.host });
      ctx.state.ssh = this._sshFactory({
        host: ctx.state.host || config.host,
        port: config.port,
        username: config.username,
        identityFile: config.certRoute,
      });
    }
    return ctx.state.ssh;
  }

  _deployDir(ctx) {
    return `${ctx.config.remoteRepoPath}/deploy`;
  }

  /** exec function for Compose: runs argv on the server inside deploy/. */
  _remoteExec(ctx) {
    const ssh = this._ssh(ctx);
    const dir = this._deployDir(ctx);
    return (argv, opts = {}) =>
      ssh.exec(`cd ${shQuote(dir)} && ${argv.map(shQuote).join(" ")}`, {
        signal: ctx.signal,
        ...opts,
      });
  }

  /** `projectName` is explicit: undefined means compose's default (folder name). */
  _compose(ctx, projectName) {
    return new Compose({
      exec: this._remoteExec(ctx),
      prefix: ctx.state.prefix,
      projectName,
    });
  }

  async _package(ctx) {
    const source = getAbsolutePath(ctx.config.repoPath);
    if (!fs.existsSync(source)) throw new Error(`Folder not found: ${source}`);

    const zipName = `${path.basename(source)}-${Date.now()}.zip`;
    const zipPath = path.join(os.tmpdir(), zipName);
    ctx.state.zipPath = zipPath;
    ctx.state.zipName = zipName;
    ctx.onCleanup(() => fs.rmSync(zipPath, { force: true }));

    const started = Date.now();
    const { files, bytes } = await compressFolder(source, zipPath);
    ctx.log(
      `${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${formatDuration(Date.now() - started)}`,
    );
  }

  async _connect(ctx) {
    const ssh = this._ssh(ctx);
    const retries = this.connectRetries();
    for (let attempt = 0; ; attempt++) {
      try {
        await ssh.exec("true", { signal: ctx.signal, timeoutMs: 30000 });
        return;
      } catch (error) {
        if (attempt >= retries || ctx.signal?.aborted) {
          error.message = `Could not connect via ssh to ${ctx.config.username}@${ctx.state.host || ctx.config.host}: ${error.tail?.(3) || error.message}`;
          throw error;
        }
        ctx.log(
          `Server not reachable yet, retrying (${attempt + 1}/${retries})...`,
        );
        await this._sleep(10000);
      }
    }
  }

  async _prepare(ctx) {
    const ssh = this._ssh(ctx);
    const opts = { signal: ctx.signal };
    const check = await ssh.exec(CHECK_DOCKER_SCRIPT, opts);
    const ready = check.stdout.split(/\r?\n/).some((l) => l.trim() === "READY");

    if (!ready) {
      await ssh.exec(PROVISION_SCRIPT, { ...opts, onLine: (l) => ctx.log(l) });
    }

    // A group added just now is not active in this session: fall back to sudo
    let sudo = false;
    try {
      await ssh.exec("docker info >/dev/null 2>&1", opts);
    } catch {
      try {
        await ssh.exec("sudo -n docker info >/dev/null 2>&1", opts);
        sudo = true;
      } catch {
        throw new Error(
          "Docker is installed but not running or not usable on the server.",
        );
      }
    }
    ctx.state.sudo = sudo;

    ctx.state.prefix = await Compose.detectPrefix(
      (argv) => ssh.exec(argv.map(shQuote).join(" "), opts),
      { sudo },
    );
    if (!ctx.state.prefix)
      throw new Error("Docker Compose is not available on the server.");

    return ready
      ? { skipped: true, detail: "Docker already installed" }
      : undefined;
  }

  async _stopPrevious(ctx) {
    const ssh = this._ssh(ctx);
    const dir = ctx.config.remoteRepoPath;
    const composeFile = `${dir}/deploy/docker-compose.yml`;
    const exists = await ssh
      .exec(`[ -f ${shQuote(composeFile)} ] && echo YES || echo NO`, {
        signal: ctx.signal,
      })
      .then((r) => r.stdout.includes("YES"));
    if (!exists) return { skipped: true, detail: "nothing deployed yet" };

    // Named project (this version) and the default one (deployments made by 1.x)
    for (const name of new Set([ctx.config.projectName, undefined])) {
      try {
        await this._compose(ctx, name).down({ onLine: (l) => ctx.log(l) });
      } catch (error) {
        ctx.log(`(ignored) ${error.tail?.(2) || error.message}`);
      }
    }
  }

  async _upload(ctx) {
    const ssh = this._ssh(ctx);
    const dir = shQuote(ctx.config.remoteRepoPath);
    const opts = { signal: ctx.signal };

    await ssh.exec(
      `DIR=${dir}
mkdir -p "$DIR" 2>/dev/null || { sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR"; }
find "$DIR" -mindepth 1 -delete 2>/dev/null || sudo find "$DIR" -mindepth 1 -delete
${INSTALL_UNZIP}`,
      opts,
    );

    await ssh.upload(ctx.state.zipPath, ctx.config.remoteRepoPath, opts);

    const zip = shQuote(`${ctx.config.remoteRepoPath}/${ctx.state.zipName}`);
    await ssh.exec(`unzip -oq ${zip} -d ${dir} && rm -f ${zip}`, opts);
  }

  async _up(ctx) {
    const compose = this._compose(ctx, ctx.config.projectName);
    try {
      await compose.up({ onLine: (l) => ctx.log(l) });
    } catch (error) {
      const details = await compose.diagnose();
      if (details) error.message += `\n${details}`;
      throw error;
    }
  }

  async _wait(ctx) {
    await this._compose(ctx, ctx.config.projectName).waitForServices({
      signal: ctx.signal,
      onStatus: (services) => ctx.emit({ type: "services", services }),
    });
  }
}

export default RemoteStrategy;
