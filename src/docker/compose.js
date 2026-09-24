/**
 * @file compose.js
 * @description docker compose helper that works the same locally and over ssh:
 * everything goes through an injected `exec(argv, opts)` function, so this file
 * knows nothing about where the commands run.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `docker compose ps --format json` prints a JSON array (compose < 2.21) or
 * one JSON object per line (newer versions).
 * @param {String} stdout
 * @returns {Array<{name: String, container: String, state: String, health: String, exitCode: Number}>}
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
  }));
};

/**
 * @param {{state: String, health: String, exitCode: Number}} service
 * @returns {"ready"|"pending"|"failed"}
 */
export const classify = ({ state, health, exitCode }) => {
  if (state === "exited" || state === "dead") {
    return exitCode === 0 ? "ready" : "failed";
  }
  if (health === "unhealthy") return "failed";
  if (state === "running") {
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

  up(opts = {}) {
    return this._exec(
      this._argv(["up", "-d", "--build", "--remove-orphans"]),
      opts,
    );
  }

  down(opts = {}) {
    return this._exec(this._argv(["down", "-v", "--remove-orphans"]), opts);
  }

  async ps() {
    const { stdout } = await this._exec(
      this._argv(["ps", "-a", "--format", "json"]),
    );
    return parsePs(stdout);
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
   * @returns {Promise<Array>} the final service list
   */
  async waitForServices({
    timeoutMs = 10 * 60 * 1000,
    pollMs = 3000,
    onStatus,
    signal,
    sleepFn = sleep,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = [];

    for (;;) {
      if (signal?.aborted) throw new Error("Aborted");

      last = await this.ps();
      const report = last.map((s) => ({ ...s, status: classify(s) }));
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
