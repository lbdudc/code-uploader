import { normalizeConfig } from "../config.js";
import { formatDuration } from "../utils/utils.js";

/**
 * Event emitted while a deployment runs.
 * @typedef {Object} DeployEvent
 * @property {"step"|"log"|"services"} type
 * @property {String} [id] step id (type "step")
 * @property {String} [label] human readable step name (type "step")
 * @property {"running"|"done"|"failed"|"skipped"} [status] (type "step")
 * @property {Number} [index] 1-based step position (type "step")
 * @property {Number} [total] number of steps (type "step")
 * @property {Number} [durationMs] (type "step", when finished)
 * @property {String} [detail] extra text (type "step")
 * @property {String} [step] id of the step that produced the line (type "log")
 * @property {String} [line] (type "log")
 * @property {Array} [services] (type "services")
 */

/**
 * Prints events as plain console lines. Used when the caller gives no
 * `onEvent`, which is how 1.x callers (`uploadCode(config)`) keep working.
 * @param {DeployEvent} event
 */
export const consoleReporter = (event) => {
  if (event.type === "step") {
    const prefix = `STEP ${event.index}/${event.total} - ${event.label}`;
    if (event.status === "running") console.log(`${prefix}...`);
    else if (event.status === "skipped") {
      console.log(
        `${prefix}: skipped${event.detail ? ` (${event.detail})` : ""}`,
      );
    } else if (event.status === "failed") console.error(`${prefix}: FAILED`);
    else console.log(`${prefix}: done (${formatDuration(event.durationMs)})`);
  } else if (event.type === "log") {
    console.log(`    ${event.line}`);
  }
};

/**
 * Base class of every upload strategy. Subclasses implement `plan(config)`,
 * returning the ordered steps; this class runs them, reports progress and
 * guarantees that a failing step aborts the deployment.
 */
/** The compose service that loads the data (see the generated docker-compose.yml). */
export const IMPORTER_SERVICE = "data-importer";

class UploadStrategy {
  /**
   * @param {Object} config
   * @returns {Array<{id: String, label: String, run: (ctx: Object) => Promise<void|{skipped: true, detail?: String}>}>}
   */
  // eslint-disable-next-line no-unused-vars
  plan(config) {
    throw new Error("This method must be overwritten!");
  }

  /**
   * URL where the deployed app is reachable.
   * @param {Object} config Normalized config
   * @param {Object} state State shared by the steps
   * @returns {String}
   */
  // eslint-disable-next-line no-unused-vars
  resolveUrl(config, state) {
    return config.url || null;
  }

  /**
   * The steps `deploy` will run, so a UI can list them before starting.
   * @param {Object} config
   * @returns {Array<{id: String, label: String}>}
   */
  describe(config) {
    return this.plan(normalizeConfig(config)).map(({ id, label }) => ({
      id,
      label,
    }));
  }

  /**
   * Runs the deployment.
   * @param {Object} config
   * @param {Object} [opts]
   * @param {(event: DeployEvent) => void} [opts.onEvent]
   * @param {AbortSignal} [opts.signal] Aborting stops the running command
   * @returns {Promise<{url: String|null}>}
   */
  async deploy(config, opts = {}) {
    const normalized = normalizeConfig(config);
    return this._runSteps(this.plan(normalized), normalized, opts);
  }

  /**
   * The steps `updateData` will run. Only local and ssh deployments can do it (an update
   * reloads the data of a stack that is already running).
   * @param {Object} config
   * @returns {Array<{id: String, label: String}>}
   */
  describeUpdate(config) {
    return this._planUpdate(normalizeConfig(config)).map(({ id, label }) => ({
      id,
      label,
    }));
  }

  /**
   * Loads new or changed data into the running stack: the data importer runs again (it
   * only reloads the layers whose content changed), with no rebuild and no restart of
   * the rest. Same `opts` and events as `deploy`.
   * @param {Object} config
   * @param {Object} [opts]
   * @returns {Promise<{url: String|null}>}
   */
  async updateData(config, opts = {}) {
    const normalized = normalizeConfig(config);
    return this._runSteps(this._planUpdate(normalized), normalized, opts);
  }

  // eslint-disable-next-line no-unused-vars
  _planUpdate(config) {
    throw new Error("This deployment type cannot update the data of a running stack");
  }

  async _runSteps(steps, normalized, { onEvent = consoleReporter, signal } = {}) {
    const state = {};
    const cleanups = [];
    let current = null;

    const ctx = {
      config: normalized,
      state,
      signal,
      emit: onEvent,
      log: (line) => onEvent({ type: "log", step: current?.id, line }),
      onCleanup: (fn) => cleanups.push(fn),
    };

    try {
      for (const [i, step] of steps.entries()) {
        if (signal?.aborted) throw new Error("Aborted");
        current = step;
        const base = {
          type: "step",
          id: step.id,
          label: step.label,
          index: i + 1,
          total: steps.length,
        };
        const started = Date.now();
        onEvent({ ...base, status: "running" });
        try {
          const result = await step.run(ctx);
          const skipped = !!result?.skipped;
          onEvent({
            ...base,
            status: skipped ? "skipped" : "done",
            detail: result?.detail,
            durationMs: Date.now() - started,
          });
        } catch (error) {
          onEvent({
            ...base,
            status: "failed",
            detail: error.message,
            durationMs: Date.now() - started,
          });
          error.step = step.id;
          throw error;
        }
      }
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {
          // cleanup is best effort
        }
      }
    }

    return { url: this.resolveUrl(normalized, state), ...this.resultDetails(normalized, state) };
  }

  /**
   * More to report than the URL (a package has a file, not a URL).
   * @param {Object} config Normalized config
   * @param {Object} state State shared by the steps
   * @returns {Object}
   */
  // eslint-disable-next-line no-unused-vars
  resultDetails(config, state) {
    return {};
  }

  /**
   * 1.x compatibility: same as `deploy`, logging to the console.
   * @param {Object} config
   * @returns {Promise<String|null>} the app URL
   */
  async uploadCode(config) {
    const { url } = await this.deploy(config);
    return url;
  }
}

export default UploadStrategy;
