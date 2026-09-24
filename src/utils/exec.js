import { spawn } from "child_process";

/**
 * Error thrown when a spawned command exits non-zero, is killed, or times out.
 */
export class CommandError extends Error {
  constructor(
    message,
    { command, code = null, stdout = "", stderr = "" } = {},
  ) {
    super(message);
    this.name = "CommandError";
    this.command = command;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /** Last `n` non-empty lines of stderr (falling back to stdout). */
  tail(n = 10) {
    const text = (this.stderr || this.stdout || "").trim();
    return text.split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
  }
}

const splitLines = (buffer, chunk, flush) => {
  const parts = (buffer + chunk).split(/\r?\n|\r/);
  const rest = flush ? "" : parts.pop();
  return { lines: parts, rest };
};

/**
 * Runs an executable WITHOUT a shell (no quoting differences between Windows
 * and POSIX, no `cd x && y` drive problems: use `cwd` instead).
 *
 * @param {String} cmd Executable name or path
 * @param {String[]} args Arguments, passed as-is
 * @param {Object} [opts]
 * @param {String} [opts.cwd]
 * @param {Object} [opts.env] Extra environment variables
 * @param {String} [opts.input] Written to stdin, then stdin is closed
 * @param {AbortSignal} [opts.signal] Aborting kills the process and rejects
 * @param {Number} [opts.timeoutMs] Kills the process and rejects on expiry
 * @param {(line: String, stream: "stdout"|"stderr") => void} [opts.onLine]
 * @returns {Promise<{stdout: String, stderr: String, code: Number}>}
 */
export const run = (cmd, args = [], opts = {}) => {
  const { cwd, env, input, signal, timeoutMs, onLine } = opts;
  const display = [cmd, ...args].join(" ");

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CommandError("Aborted", { command: display }));
      return;
    }

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new CommandError(error.message, { command: display }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let settled = false;
    let timer = null;
    let failure = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    const stop = (message) => {
      failure = failure || message;
      child.kill("SIGKILL");
    };
    const onAbort = () => stop("Aborted");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) {
      timer = setTimeout(
        () => stop(`Timed out after ${Math.round(timeoutMs / 1000)}s`),
        timeoutMs,
      );
    }

    const feed = (stream, data) => {
      const text = data.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (!onLine) return;
      const isOut = stream === "stdout";
      const { lines, rest } = splitLines(isOut ? outBuf : errBuf, text, false);
      if (isOut) outBuf = rest;
      else errBuf = rest;
      for (const line of lines) if (line.trim()) onLine(line, stream);
    };
    child.stdout.on("data", (d) => feed("stdout", d));
    child.stderr.on("data", (d) => feed("stderr", d));

    child.on("error", (error) => {
      finish(
        reject,
        new CommandError(
          error.code === "ENOENT" ? `Command not found: ${cmd}` : error.message,
          { command: display, stdout, stderr },
        ),
      );
    });

    child.on("close", (code) => {
      if (onLine) {
        for (const buf of [outBuf, errBuf])
          if (buf.trim()) onLine(buf, "stdout");
      }
      if (failure) {
        finish(
          reject,
          new CommandError(failure, { command: display, code, stdout, stderr }),
        );
      } else if (code !== 0) {
        const error = new CommandError(
          `Command failed (exit ${code}): ${display}`,
          { command: display, code, stdout, stderr },
        );
        // The reason is in the output, not in the exit code: keep it in the message
        const tail = error.tail(5);
        if (tail) error.message += `\n${tail}`;
        finish(reject, error);
      } else {
        finish(resolve, { stdout, stderr, code });
      }
    });

    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
};
