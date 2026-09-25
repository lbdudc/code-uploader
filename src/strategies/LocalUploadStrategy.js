import fs from "fs";
import path from "path";
import UploadStrategy from "./UploadStrategy.js";
import { run } from "../utils/exec.js";
import { getAbsolutePath } from "../utils/utils.js";
import { Compose } from "../docker/compose.js";
import { IMPORTER_SERVICE } from "./UploadStrategy.js";

/**
 * Runs the generated stack with the Docker installation of this machine.
 */
class LocalUploadStrategy extends UploadStrategy {
  constructor({ runFn = run } = {}) {
    super();
    this._run = runFn;
  }

  plan() {
    return [
      {
        id: "docker",
        label: "Check Docker",
        run: (ctx) => this._checkDocker(ctx),
      },
      {
        id: "stop",
        label: "Stop previous deployment",
        run: (ctx) => this._stopPrevious(ctx),
      },
      {
        id: "build",
        label: "Build & start services",
        run: (ctx) => this._up(ctx),
      },
      { id: "wait", label: "Wait for services", run: (ctx) => this._wait(ctx) },
    ];
  }

  _planUpdate() {
    return [
      {
        id: "docker",
        label: "Check Docker",
        run: (ctx) => this._checkDocker(ctx),
      },
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
    const compose = this._composeFor(ctx);
    const missing = await compose.notRunning([IMPORTER_SERVICE, "server"]);
    if (missing.includes("server")) {
      throw new Error(
        "The app is not running: deploy it first (updating the data needs the running server).",
      );
    }
    if (missing.includes(IMPORTER_SERVICE) === false) {
      // it exists and runs (an import in progress): let it finish, then run it again
      ctx.log("A data import is still running: it is restarted.");
    }
    await compose.up({
      services: [IMPORTER_SERVICE],
      build: false,
      onLine: (line) => ctx.log(line),
    });
  }

  async _waitImporter(ctx) {
    await this._composeFor(ctx).waitForServices({
      services: [IMPORTER_SERVICE],
      signal: ctx.signal,
      onStatus: (services) => ctx.emit({ type: "services", services }),
    });
  }

  resolveUrl(config) {
    return config.url || "http://localhost";
  }

  _deployDir(config) {
    return path.join(getAbsolutePath(config.repoPath), "deploy");
  }

  _compose(ctx) {
    const cwd = this._deployDir(ctx.config);
    const exec = (argv, opts = {}) =>
      this._run(argv[0], argv.slice(1), { cwd, signal: ctx.signal, ...opts });
    return { exec, cwd };
  }

  async _checkDocker(ctx) {
    const { exec, cwd } = this._compose(ctx);
    if (!fs.existsSync(path.join(cwd, "docker-compose.yml"))) {
      throw new Error(`No docker-compose.yml found in ${cwd}`);
    }
    try {
      await exec(["docker", "info"], { timeoutMs: 30000 });
    } catch (error) {
      if (/not found/i.test(error.message)) {
        throw new Error(
          "Docker is not installed (the `docker` command was not found).",
        );
      }
      throw new Error(
        "Docker is not running. Start Docker Desktop (or the Docker service) and try again.",
      );
    }
    ctx.state.prefix = await Compose.detectPrefix(exec);
    if (!ctx.state.prefix) {
      throw new Error(
        "Docker Compose is not installed (neither `docker compose` nor `docker-compose`).",
      );
    }
  }

  _composeFor(ctx) {
    const { exec } = this._compose(ctx);
    return new Compose({
      exec,
      prefix: ctx.state.prefix,
      projectName: ctx.config.projectName,
    });
  }

  async _stopPrevious(ctx) {
    try {
      await this._composeFor(ctx).down({
        volumes: !!ctx.config.resetData,
        onLine: (line) => ctx.log(line),
      });
    } catch (error) {
      ctx.log(
        `(ignored) could not stop the previous deployment: ${error.message}`,
      );
    }
  }

  async _up(ctx) {
    const compose = this._composeFor(ctx);
    try {
      await compose.up({ onLine: (line) => ctx.log(line) });
    } catch (error) {
      const details = await compose.diagnose();
      if (details) error.message += `\n${details}`;
      throw error;
    }
  }

  async _wait(ctx) {
    await this._composeFor(ctx).waitForServices({
      signal: ctx.signal,
      onStatus: (services) => ctx.emit({ type: "services", services }),
    });
  }
}

export default LocalUploadStrategy;
