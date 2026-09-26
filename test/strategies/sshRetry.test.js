import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import DebianUploadStrategy from "../../src/strategies/DebianUploadStrategy.js";
import { CommandError } from "../../src/utils/exec.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-retry-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const READY_ROW = JSON.stringify({ Service: "web", Name: "w", State: "running", Health: "healthy", ExitCode: 0 });

const config = () => ({
  type: "ssh",
  host: "203.0.113.5",
  username: "deploy",
  certRoute: "/k",
  remoteRepoPath: "/home/deploy/app",
  repoPath: repo,
});

const dropped = () => new CommandError("Command failed (exit 255): ssh", { code: 255 });

// ssh whose `docker compose ps` polls fail `failures` times before answering
const flakySsh = (failures, error = dropped) => {
  let left = failures;
  return {
    exec: vi.fn(async (script) => {
      if (script.includes("echo READY")) return { stdout: "READY\n" };
      if (script.includes("&& echo YES")) return { stdout: "NO\n" };
      if (script.includes("'ps'")) {
        if (left-- > 0) throw error();
        return { stdout: READY_ROW };
      }
      return { stdout: "" };
    }),
    upload: vi.fn(async () => {}),
  };
};

describe("waiting for the stack over ssh", () => {
  test("a dropped connection during the polls is tried again and the deployment succeeds", async () => {
    const ssh = flakySsh(2);
    const sleeps = [];
    const events = [];
    const strategy = new DebianUploadStrategy({
      sshFactory: () => ssh,
      sleepFn: async (ms) => sleeps.push(ms),
    });
    const result = await strategy.deploy(config(), { onEvent: (e) => events.push(e) });
    expect(result.url).toBe("http://203.0.113.5");
    expect(events.filter((e) => e.type === "log" && /Connection to the server lost/.test(e.line))).toHaveLength(2);
    expect(sleeps.filter((ms) => ms === 5000)).toHaveLength(2);
  });

  test("a server that stays unreachable still fails, after a few tries", async () => {
    const ssh = flakySsh(100);
    const strategy = new DebianUploadStrategy({ sshFactory: () => ssh, sleepFn: async () => {} });
    await expect(strategy.deploy(config(), { onEvent: () => {} })).rejects.toThrow(/exit 255/);
    expect(ssh.exec.mock.calls.filter(([s]) => s.includes("'ps'"))).toHaveLength(6); // first try + 5 retries
  });

  test("other failures are not retried", async () => {
    const ssh = flakySsh(100, () => new CommandError("Command failed (exit 1): docker", { code: 1 }));
    const strategy = new DebianUploadStrategy({ sshFactory: () => ssh, sleepFn: async () => {} });
    await expect(strategy.deploy(config(), { onEvent: () => {} })).rejects.toThrow(/exit 1/);
    expect(ssh.exec.mock.calls.filter(([s]) => s.includes("'ps'"))).toHaveLength(1);
  });
});
