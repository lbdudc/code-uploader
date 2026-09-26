import os from "os";
import dns from "dns";
import fs from "fs";
import path from "path";
import UploadStrategy, { IMPORTER_SERVICE } from "./UploadStrategy.js";
import { SSHClient } from "../ssh.js";
import { assertRemoteConfig } from "../config.js";
import { compressFolder, hashFolder, isScript } from "../utils/zipUtils.js";
import { getAbsolutePath, shQuote, formatDuration } from "../utils/utils.js";
import { Compose } from "../docker/compose.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ssh exits 255 when it cannot connect or the connection drops: waiting polls try again this many times */
const SSH_POLL_RETRIES = 5;
const SSH_POLL_RETRY_MS = 5000;

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

/**
 * argv as a shell command that runs with `env` set on the server. Through sudo the
 * variables have to go after it (`sudo env K=V cmd`): sudo resets the environment.
 */
export const withRemoteEnv = (argv, env = {}) => {
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  if (assignments.length === 0) return argv.map(shQuote).join(" ");
  const sudo = argv[0] === "sudo" ? argv.slice(0, 1) : [];
  return [...sudo, "env", ...assignments, ...argv.slice(sudo.length)]
    .map(shQuote)
    .join(" ");
};

const INSTALL_UNZIP = `command -v unzip >/dev/null 2>&1 || {
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y -qq unzip;
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y unzip;
  else sudo yum install -y unzip; fi
}`;

/**
 * What the server holds from the previous deploy (relative path -> SHA-256), written after
 * every complete upload. Its absence (first deploy, or an upload that was interrupted)
 * means a full upload.
 */
const MANIFEST_NAME = ".gp-manifest.json";

/** Paths taken from the remote manifest go into `rm`: only plain relative ones. */
const isSafeRelativePath = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !p.startsWith("/") &&
  !p.split("/").includes("..");

/**
 * Deploys over ssh to a Linux machine with Docker (installed on demand).
 * Concrete strategies (Debian/Ubuntu, AWS) extend it.
 */
class RemoteStrategy extends UploadStrategy {
  constructor({ sshFactory, sleepFn = sleep, lookupFn } = {}) {
    super();
    this._sshFactory = sshFactory || ((opts) => new SSHClient(opts));
    this._sleep = sleepFn;
    // every address a name resolves to, as strings
    this._lookup =
      lookupFn ||
      (async (name) =>
        (await dns.promises.lookup(name, { all: true })).map((a) => a.address));
  }

  /** Steps that run before the ssh ones (e.g. creating an EC2 instance). */
  // eslint-disable-next-line no-unused-vars
  preSteps(config) {
    return [];
  }

  /** How many times to retry the first connection (a fresh VM boots slowly). */
  connectRetries() {
    return 0;
  }

  plan(config = {}) {
    return [
      ...this.preSteps(config),
      ...(config.domain
        ? [
            {
              id: "domain",
              label: "Check the domain",
              run: (ctx) => this._checkDomain(ctx),
            },
          ]
        : []),
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
        id: "package",
        label: "Package code",
        run: (ctx) => this._package(ctx),
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
    if (config.url) return config.url;
    // with a domain the app answers over HTTPS there (the stack's own HTTPS front)
    if (config.domain) return `https://${config.domain}`;
    return `http://${state.host || config.host}`;
  }

  /**
   * The HTTPS certificate is issued only if the domain leads to this server, and a wrong
   * domain would otherwise show up as a site that never answers after the whole build. On a
   * server the deployment has just created the domain can't be right yet: that is only
   * warned about (the certificate is issued as soon as the domain points at it).
   */
  async _checkDomain(ctx) {
    const { domain } = ctx.config;
    const host = ctx.state.host || ctx.config.host;
    const addresses = async (name) => {
      try {
        return await this._lookup(name);
      } catch {
        return [];
      }
    };
    const [domainIps, serverIps] = await Promise.all([
      addresses(domain),
      addresses(host),
    ]);

    if (domainIps.some((ip) => serverIps.includes(ip))) {
      return { detail: `${domain} points to ${host}` };
    }

    const seen = domainIps.length
      ? `${domain} points to ${domainIps.join(", ")}`
      : `${domain} does not point anywhere yet`;
    const message = `${seen}, not to the server (${serverIps.join(", ") || host}). Point the domain at the server so the HTTPS certificate can be issued.`;
    if (ctx.state.created) {
      ctx.log(`Warning: ${message}`);
      return { detail: "the domain does not point at the new server yet" };
    }
    throw new Error(message);
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

  /**
   * exec function for Compose: runs argv on the server inside deploy/.
   * With `retryConnection`, a failed ssh connection (exit 255: the server or the network hiccuped)
   * is tried again a few times. Only for commands that can safely run twice, such as the polls that
   * wait for the stack: losing one of dozens of polls must not fail a deployment that worked.
   */
  _remoteExec(ctx, { retryConnection = false } = {}) {
    const ssh = this._ssh(ctx);
    const dir = this._deployDir(ctx);
    return async (argv, { env, ...opts } = {}) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await ssh.exec(`cd ${shQuote(dir)} && ${withRemoteEnv(argv, env)}`, {
            signal: ctx.signal,
            ...opts,
          });
        } catch (error) {
          if (!retryConnection || error.code !== 255 || attempt >= SSH_POLL_RETRIES || ctx.signal?.aborted) {
            throw error;
          }
          ctx.log(`Connection to the server lost, trying again (${attempt + 1}/${SSH_POLL_RETRIES})...`);
          await this._sleep(SSH_POLL_RETRY_MS);
        }
      }
    };
  }

  /** `projectName` is explicit: undefined means compose's default (folder name). */
  _compose(ctx, projectName, { retryConnection = false } = {}) {
    return new Compose({
      exec: this._remoteExec(ctx, { retryConnection }),
      prefix: ctx.state.prefix,
      projectName,
    });
  }

  /** The manifest of the previous deploy, or null when it can't be trusted. */
  async _readRemoteManifest(ctx) {
    const file = shQuote(`${ctx.config.remoteRepoPath}/${MANIFEST_NAME}`);
    try {
      const { stdout } = await this._ssh(ctx).exec(
        `cat ${file} 2>/dev/null || true`,
        { signal: ctx.signal },
      );
      const files = JSON.parse(stdout).files;
      return files && typeof files === "object" ? files : null;
    } catch {
      return null;
    }
  }

  /**
   * Zips only what differs from the server's copy (first deploy: everything), so a
   * redeploy sends the few changed files instead of hundreds of MB of unchanged data.
   */
  async _package(ctx) {
    const source = getAbsolutePath(ctx.config.repoPath);
    if (!fs.existsSync(source)) throw new Error(`Folder not found: ${source}`);

    const started = Date.now();
    const local = await hashFolder(source);
    const remote = await this._readRemoteManifest(ctx);

    const changed = Object.keys(local).filter(
      (file) => !remote || remote[file] !== local[file],
    );
    ctx.state.manifest = { version: 1, files: local };
    ctx.state.incremental = !!remote;
    ctx.state.removed = remote
      ? Object.keys(remote).filter((file) => !(file in local))
      : [];
    ctx.state.zipPath = null;

    let bytes = 0;
    if (changed.length > 0) {
      const zipName = `${path.basename(source)}-${Date.now()}.zip`;
      const zipPath = path.join(os.tmpdir(), zipName);
      ctx.state.zipPath = zipPath;
      ctx.state.zipName = zipName;
      ctx.onCleanup(() => fs.rmSync(zipPath, { force: true }));
      ({ bytes } = await compressFolder(source, zipPath, {
        files: changed,
        isExecutable: isScript,
      }));
    }

    ctx.log(
      `${remote ? "Incremental" : "Full"} upload: ${changed.length} of ${Object.keys(local).length} files ` +
        `(${(bytes / 1024 / 1024).toFixed(1)} MB) in ${formatDuration(Date.now() - started)}` +
        (ctx.state.removed.length
          ? `, ${ctx.state.removed.length} removed`
          : ""),
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

    await this._detectCompose(ctx);

    return ready
      ? { skipped: true, detail: "Docker already installed" }
      : undefined;
  }

  /** Finds how to run docker compose on the server (with or without sudo), or fails. */
  async _detectCompose(ctx) {
    const ssh = this._ssh(ctx);
    const opts = { signal: ctx.signal };

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
  }

  /** An update reloads data of an app that is there: nothing to update on an empty folder. */
  async _assertDeployed(ctx) {
    const composeFile = `${ctx.config.remoteRepoPath}/deploy/docker-compose.yml`;
    const { stdout } = await this._ssh(ctx).exec(
      `[ -f ${shQuote(composeFile)} ] && echo YES || echo NO`,
      { signal: ctx.signal },
    );
    if (!stdout.includes("YES")) {
      throw new Error(
        `Nothing is deployed in ${ctx.config.remoteRepoPath} on the server: deploy the app first.`,
      );
    }
  }

  _planUpdate() {
    return [
      {
        id: "connect",
        label: "Connect to server",
        run: (ctx) => this._connect(ctx),
      },
      {
        id: "check",
        label: "Check the app",
        run: async (ctx) => {
          await this._detectCompose(ctx);
          await this._assertDeployed(ctx);
        },
      },
      {
        id: "package",
        label: "Package data",
        run: (ctx) => this._package(ctx),
      },
      { id: "upload", label: "Upload data", run: (ctx) => this._upload(ctx) },
      {
        id: "import",
        label: "Load the data",
        run: (ctx) => this._runImporter(ctx),
      },
      {
        id: "wait",
        label: "Wait for the import",
        run: (ctx) => this._waitImporter(ctx),
      },
    ];
  }

  async _runImporter(ctx) {
    const compose = this._compose(ctx, ctx.config.projectName);
    const missing = await compose.notRunning(["server"]);
    if (missing.length > 0) {
      throw new Error(
        "The app is not running on the server: deploy it first (updating the data needs the running server).",
      );
    }
    await compose.up({
      services: [IMPORTER_SERVICE],
      build: false,
      onLine: (l) => ctx.log(l),
    });
  }

  async _waitImporter(ctx) {
    await this._compose(ctx, ctx.config.projectName, { retryConnection: true }).waitForServices({
      services: [IMPORTER_SERVICE],
      signal: ctx.signal,
      onStatus: (services) => ctx.emit({ type: "services", services }),
    });
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
        await this._compose(ctx, name).down({
          volumes: !!ctx.config.resetData,
          onLine: (l) => ctx.log(l),
        });
      } catch (error) {
        ctx.log(`(ignored) ${error.tail?.(2) || error.message}`);
      }
    }
  }

  async _upload(ctx) {
    const ssh = this._ssh(ctx);
    const dir = shQuote(ctx.config.remoteRepoPath);
    const opts = { signal: ctx.signal };
    const { incremental, manifest, zipPath, zipName } = ctx.state;
    const manifestFile = `"$DIR"/${MANIFEST_NAME}`;

    // The manifest goes first, and is written back only once everything is in place: an
    // interrupted upload leaves none, so the next deploy sends everything again.
    const removals = ctx.state.removed
      .filter(isSafeRelativePath)
      .map((file) => shQuote(file));
    const prepare = incremental
      ? [
          `DIR=${dir}`,
          `mkdir -p "$DIR" 2>/dev/null || { sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR"; }`,
          `rm -f ${manifestFile}`,
          // in batches: a long list would overflow the command line
          ...Array.from(
            { length: Math.ceil(removals.length / 100) },
            (_, i) =>
              `(cd "$DIR" && rm -f -- ${removals.slice(i * 100, i * 100 + 100).join(" ")})`,
          ),
        ]
      : [
          `DIR=${dir}`,
          `mkdir -p "$DIR" 2>/dev/null || { sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR"; }`,
          `find "$DIR" -mindepth 1 -delete 2>/dev/null || sudo find "$DIR" -mindepth 1 -delete`,
        ];
    if (zipPath) prepare.push(INSTALL_UNZIP);
    await ssh.exec(prepare.join("\n"), opts);

    if (zipPath) {
      await ssh.upload(zipPath, ctx.config.remoteRepoPath, opts);
      const zip = shQuote(`${ctx.config.remoteRepoPath}/${zipName}`);
      await ssh.exec(`unzip -oq ${zip} -d ${dir} && rm -f ${zip}`, opts);
    }

    await ssh.exec(
      `DIR=${dir}
cat > ${manifestFile} <<'GP_MANIFEST_EOF'
${JSON.stringify(manifest)}
GP_MANIFEST_EOF`,
      opts,
    );
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
    await this._compose(ctx, ctx.config.projectName, { retryConnection: true }).waitForServices({
      signal: ctx.signal,
      onStatus: (services) => ctx.emit({ type: "services", services }),
    });
  }
}

export default RemoteStrategy;
