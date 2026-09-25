/**
 * @file compose.js
 * @description docker compose helper that works the same locally and over ssh:
 * everything goes through an injected `exec(argv, opts)` function, so this file
 * knows nothing about where the commands run.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compose services that run to completion carry the label `gp.oneshot=true`
 * (`ps` prints all labels as `k=v,k=v`).
 */
const ONESHOT_LABEL = /(^|,)gp\.oneshot=true(,|$)/;

export const BUILDKIT_ENV = {
  DOCKER_BUILDKIT: "1",
  COMPOSE_DOCKER_CLI_BUILD: "1",
};

/**
 * `docker compose ps --format json` prints a JSON array (compose < 2.21) or
 * one JSON object per line (newer versions).
 * @param {String} stdout
 * @returns {Array<{name: String, container: String, state: String, health: String, exitCode: Number, oneshot: Boolean}>}
 */
export const parsePs = (stdout) => {
  const text = (stdout || "").trim();
  if (!text) return [];

  let rows;
  if (text.startsWith("[")) {
    rows = JSON.parse(text);
  } else {
    rows = text
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line));
  }

  return rows.map((row) => ({
    name: row.Service || row.Name,
    container: row.Name,
    state: String(row.State || "").toLowerCase(),
    health: String(row.Health || "").toLowerCase(),
    exitCode: Number(row.ExitCode ?? 0),
    oneshot: ONESHOT_LABEL.test(String(row.Labels || "")),
  }));
};

/**
 * @param {{state: String, health: String, exitCode: Number, oneshot?: Boolean}} service
 * @returns {"ready"|"pending"|"failed"}
 */
export const classify = ({ state, health, exitCode, oneshot }) => {
  if (state === "exited" || state === "dead") {
    return exitCode === 0 ? "ready" : "failed";
  }
  if (health === "unhealthy") return "failed";
  if (state === "running") {
    // A one-shot job (the data importer) is done when it exits, not while it runs
    if (oneshot) return "pending";
    return !health || health === "healthy" ? "ready" : "pending";
  }
  return "pending"; // created, restarting, paused...
};

export class Compose {
  /**
   * @param {Object} opts
   * @param {(argv: String[], opts?: Object) => Promise<{stdout: String}>} opts.exec
   * @param {String[]} opts.prefix e.g. ["docker", "compose"] or ["sudo", "docker-compose"]
   * @param {String} [opts.projectName]
   */
  constructor({ exec, prefix, projectName }) {
    this._exec = exec;
    this.prefix = prefix;
    this.projectName = projectName;
  }

  /**
   * Finds which compose flavour is available: the v2 plugin (`docker compose`)
   * or the legacy `docker-compose` binary.
   * @returns {Promise<String[]|null>} the argv prefix, or null when none works
   */
  static async detectPrefix(exec, { sudo = false } = {}) {
    const base = sudo ? ["sudo"] : [];
    const candidates = [
      [...base, "docker", "compose"],
      [...base, "docker-compose"],
    ];
    for (const prefix of candidates) {
      try {
        await exec([...prefix, "version"]);
        return prefix;
      } catch {
        // try the next flavour
      }
    }
    return null;
  }

  _argv(rest) {
    const project = this.projectName ? ["-p", this.projectName] : [];
    return [...this.prefix, ...project, ...rest];
  }

  /**
   * Builds (reusing the layer cache) and starts the stack. BuildKit is asked for
   * explicitly: the generated Dockerfiles use cache mounts (npm, gradle), which the
   * legacy `docker-compose` binary only honours with these two variables.
   */
  up({ services = [], build = true, ...opts } = {}) {
    // `services` narrows `up` to those services alone (their dependencies are not
    // started: they must already run); they are recreated even when nothing changed
    const only = services.length > 0;
    const flags = [
      "-d",
      ...(build ? ["--build"] : []),
      ...(only ? ["--no-deps", "--force-recreate"] : ["--remove-orphans"]),
    ];
    return this._exec(this._argv(["up", ...flags, ...services]), {
      ...opts,
      env: { ...BUILDKIT_ENV, ...opts.env },
    });
  }

  /**
   * Stops and removes the containers. The named volumes (the database...) are kept
   * unless `volumes` is set: a redeploy then finds its data where it left it.
   * @param {Object} [opts]
   * @param {Boolean} [opts.volumes] Also delete the volumes (`down -v`)
   */
  down({ volumes = false, ...opts } = {}) {
    return this._exec(
      this._argv(["down", ...(volumes ? ["-v"] : []), "--remove-orphans"]),
      opts,
    );
  }

  async ps() {
    const { stdout } = await this._exec(
      this._argv(["ps", "-a", "--format", "json"]),
    );
    return parsePs(stdout);
  }

  /**
   * The names among `names` that are not running (or don't exist) right now.
   * @param {String[]} names
   * @returns {Promise<String[]>}
   */
  async notRunning(names) {
    const running = new Set((await this.ps()).filter((s) => s.state === "running").map((s) => s.name));
    return names.filter((name) => !running.has(name));
  }

  async logs(service, tail = 30) {
    try {
      const { stdout, stderr } = await this._exec(
        this._argv(["logs", "--no-color", "--tail", String(tail), service]),
      );
      return (stdout || stderr || "").trim();
    } catch {
      return "";
    }
  }

  /**
   * Logs of every service that is not ready, for error messages.
   * @returns {Promise<String>}
   */
  async diagnose() {
    let services;
    try {
      services = await this.ps();
    } catch {
      return "";
    }
    const problems = services.filter((s) => classify(s) !== "ready");
    const parts = [];
    for (const service of problems.slice(0, 3)) {
      const logs = await this.logs(service.name);
      parts.push(
        `--- ${service.name} (${service.state}${service.health ? `, ${service.health}` : ""}) ---\n${logs}`,
      );
    }
    return parts.join("\n\n");
  }

  /**
   * Polls until every service is ready (healthy, running without a
   * healthcheck, or a one-shot service that exited 0).
   *
   * @param {Object} [opts]
   * @param {Number} [opts.timeoutMs]
   * @param {Number} [opts.pollMs]
   * @param {(services: Array) => void} [opts.onStatus]
   * @param {AbortSignal} [opts.signal]
   * @param {(ms: Number) => Promise<void>} [opts.sleepFn] Injected for tests
   * @param {String[]} [opts.services] Only wait for these services (by name)
   * @returns {Promise<Array>} the final service list
   */
  async waitForServices({
    timeoutMs = 10 * 60 * 1000,
    pollMs = 3000,
    onStatus,
    signal,
    sleepFn = sleep,
    services,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = [];

    for (;;) {
      if (signal?.aborted) throw new Error("Aborted");

      last = await this.ps();
      // `services` (names) narrows the wait to those: the rest of the stack is not this
      // operation's concern
      const watched = services ? last.filter((s) => services.includes(s.name)) : last;
      const report = watched.map((s) => ({ ...s, status: classify(s) }));
      if (onStatus) onStatus(report);

      const failed = report.filter((s) => s.status === "failed");
      if (failed.length) {
        const details = await this.diagnose();
        throw new Error(
          `Service(s) failed: ${failed.map((s) => s.name).join(", ")}` +
            (details ? `\n${details}` : ""),
        );
      }
      if (report.length > 0 && report.every((s) => s.status === "ready")) {
        return report;
      }
      if (Date.now() >= deadline) {
        const waiting = report
          .filter((s) => s.status !== "ready")
          .map((s) => s.name);
        const details = await this.diagnose();
        throw new Error(
          `Timed out waiting for services: ${waiting.join(", ") || "(none started)"}` +
            (details ? `\n${details}` : ""),
        );
      }
      await sleepFn(pollMs);
    }
  }
}
