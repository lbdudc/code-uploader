import { run } from "./utils/exec.js";

/**
 * Thin wrapper around the system `ssh`/`scp` binaries.
 *
 * - `BatchMode=yes`: never waits for a password/passphrase prompt (a headless
 *   run would otherwise hang forever).
 * - Scripts are sent on stdin to `bash -s`, so there is no per-OS quoting and
 *   one connection serves a whole phase.
 */
export class SSHClient {
  /**
   * @param {Object} opts
   * @param {String} opts.host
   * @param {Number} [opts.port]
   * @param {String} opts.username
   * @param {String} [opts.identityFile]
   * @param {Function} [opts.runFn] Injected for tests
   */
  constructor({ host, port = 22, username, identityFile, runFn = run }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.identityFile = identityFile;
    this._run = runFn;
  }

  _commonOptions() {
    const options = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=30",
    ];
    if (this.identityFile) options.push("-i", this.identityFile);
    return options;
  }

  /** @returns {String[]} argv (after the `ssh` executable) for a session */
  sshArgs() {
    return [
      ...this._commonOptions(),
      "-p",
      String(this.port),
      `${this.username}@${this.host}`,
      "bash",
      "-s",
    ];
  }

  /** @returns {String[]} argv (after the `scp` executable) for an upload */
  scpArgs(localFile, remoteDir) {
    return [
      ...this._commonOptions(),
      "-P",
      String(this.port),
      localFile,
      `${this.username}@${this.host}:${remoteDir}/`,
    ];
  }

  /**
   * Runs a bash script on the remote machine (fails on the first error).
   * @param {String} script
   * @param {Object} [opts] Options for `run` (onLine, signal, timeoutMs)
   */
  exec(script, opts = {}) {
    return this._run("ssh", this.sshArgs(), {
      ...opts,
      input: `set -euo pipefail\n${script}\n`,
    });
  }

  /** Copies a local file into a remote directory. */
  upload(localFile, remoteDir, opts = {}) {
    return this._run("scp", this.scpArgs(localFile, remoteDir), opts);
  }
}
