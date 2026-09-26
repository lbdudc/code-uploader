import fs from "fs";
import RemoteStrategy from "./RemoteStrategy.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The part of an ssh public key that identifies it (type and key, not the comment). */
export const keyIdentity = (publicKey) =>
  String(publicKey || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");

/**
 * A cloud provider that rents a virtual machine over a plain REST API (Hetzner Cloud,
 * DigitalOcean). The deployment finds the machine by its name or creates it (with the user's
 * ssh key and a firewall that opens 22, 80 and 443), waits until it has a public address and
 * then continues over ssh exactly like the generic ssh strategy.
 *
 * Subclasses give the provider's name, its API address and `ensureServer`. The HTTP client is
 * injectable (`fetchFn`) so the whole flow is tested against a fake API.
 */
class CloudApiStrategy extends RemoteStrategy {
  constructor(opts = {}) {
    super(opts);
    this.URL = null;
    this._fetch = opts.fetchFn || ((...args) => fetch(...args));
    this._readFile =
      opts.readFileFn || ((file) => fs.readFileSync(file, "utf8"));
    this._pollMs = opts.pollMs ?? 5000;
  }

  /** Name shown in the steps ("Hetzner Cloud"). */
  get providerName() {
    throw new Error("This property must be overwritten!");
  }

  /** Base address of the REST API, without a trailing slash. */
  get apiBase() {
    throw new Error("This property must be overwritten!");
  }

  /** Finds or creates the machine; resolves to `{ ip, created }`. */
  // eslint-disable-next-line no-unused-vars
  async ensureServer(config, log) {
    throw new Error("This method must be overwritten!");
  }

  preSteps() {
    return [
      {
        id: "instance",
        label: `Create ${this.providerName} server`,
        run: async (ctx) => {
          // What a machine of these providers has
          ctx.config.username = ctx.config.username || "root";
          ctx.config.remoteRepoPath =
            ctx.config.remoteRepoPath || "/root/gispublisher-app";
          if (ctx.config.host) {
            ctx.state.host = ctx.config.host;
            return { skipped: true, detail: `using ${ctx.config.host}` };
          }
          const { ip, created } = await this.ensureServer(ctx.config, ctx.log);
          ctx.state.host = ip;
          ctx.state.created = created;
          return created
            ? undefined
            : { detail: `using the existing server ${ctx.config.serverName}` };
        },
      },
    ];
  }

  // A fresh machine needs a while before sshd answers
  connectRetries() {
    return 18;
  }

  resolveUrl(config, state) {
    this.URL = super.resolveUrl(config, state);
    return this.URL;
  }

  getURL() {
    return this.URL;
  }

  /** The user's public ssh key: the `.pub` next to the private key, or `config.publicKey`. */
  publicKey(config) {
    if (config.publicKey) return String(config.publicKey).trim();
    const file = `${config.certRoute}.pub`;
    try {
      return this._readFile(file).trim();
    } catch {
      throw new Error(
        `The public ssh key ${file} was not found. ${this.providerName} needs it to let you in: ` +
          "create the pair with ssh-keygen (the .pub file next to the private key).",
      );
    }
  }

  token(config) {
    if (!config.cloudToken) {
      throw new Error(
        `A ${this.providerName} API token is needed (${this.tokenVariable}).`,
      );
    }
    return config.cloudToken;
  }

  /** One API call: JSON in and out, and a sentence for every failure. */
  async api(config, method, path, body) {
    let response;
    try {
      response = await this._fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token(config)}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (/API token is needed/.test(error.message)) throw error;
      throw new Error(
        `Could not reach the ${this.providerName} API: ${error.message}`,
      );
    }
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // not JSON: reported below with the status
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `${this.providerName} refused the API token (${response.status}): check that it is valid and can write.`,
        );
      }
      const reason = this.errorMessage(data) || text.slice(0, 200);
      const error = new Error(
        `${this.providerName} ${method} ${path} failed (${response.status}): ${reason}`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /** The provider's own error text out of an error response. */
  errorMessage(data) {
    return data?.error?.message || data?.message || "";
  }

  /** Calls `probe` until it returns something, or fails after `timeoutMs`. */
  async waitFor(what, probe, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.providerName}: ${what} did not happen in time.`,
        );
      }
      await (this._pollMs ? sleep(this._pollMs) : Promise.resolve());
    }
  }
}

export default CloudApiStrategy;
