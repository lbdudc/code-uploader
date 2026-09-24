import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import DebianUploadStrategy from "../../src/strategies/DebianUploadStrategy.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "remote-strategy-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const READY_ROW = JSON.stringify({ Service: "web", Name: "w", State: "running", Health: "healthy", ExitCode: 0 });

/**
 * Fake ssh: `scripts` records what would run on the server. `dockerInstalled`
 * controls the READY/MISSING probe, `deployedBefore` the compose-file probe.
 */
const fakeSsh = ({ dockerInstalled = true, deployedBefore = false, needsSudo = false, failConnect = false } = {}) => {
  const scripts = [];
  const uploads = [];
  const ssh = {
    exec: vi.fn(async (script) => {
      scripts.push(script);
      if (failConnect) throw Object.assign(new Error("ssh failed"), { tail: () => "Permission denied (publickey)" });
      if (script.includes("echo READY")) return { stdout: dockerInstalled ? "READY\n" : "MISSING\n" };
      if (script.includes("&& echo YES")) return { stdout: deployedBefore ? "YES\n" : "NO\n" };
      if (script.startsWith("docker info") && needsSudo) throw new Error("permission denied");
      if (script.includes("'ps'")) return { stdout: READY_ROW };
      return { stdout: "" };
    }),
    upload: vi.fn(async (...args) => uploads.push(args)),
  };
  return { ssh, scripts, uploads };
};

const config = () => ({
  type: "ssh",
  host: "203.0.113.5",
  port: 22,
  username: "deploy",
  certRoute: "/k",
  remoteRepoPath: "/home/deploy/app",
  repoPath: repo,
  projectName: "demo",
});

describe("DebianUploadStrategy (ssh)", () => {
  test("first deployment installs docker, uploads and starts the stack", async () => {
    const { ssh, scripts, uploads } = fakeSsh({ dockerInstalled: false });
    const events = [];
    const result = await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), {
      onEvent: (e) => events.push(e),
    });

    expect(result).toEqual({ url: "http://203.0.113.5" });
    const statuses = Object.fromEntries(
      events.filter((e) => e.type === "step" && e.status !== "running").map((e) => [e.id, e.status]),
    );
    expect(statuses).toEqual({
      package: "done",
      connect: "done",
      prepare: "done",
      stop: "skipped",
      upload: "done",
      build: "done",
      wait: "done",
    });
    expect(scripts.some((s) => s.includes("get.docker.com"))).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0][1]).toBe("/home/deploy/app");
    expect(scripts.some((s) => s.includes("'up' '-d' '--build' '--remove-orphans'"))).toBe(true);
    // the temp zip is removed afterwards
    expect(fs.existsSync(uploads[0][0])).toBe(false);
  });

  test("redeploy skips provisioning and stops the previous stack first", async () => {
    const { ssh, scripts } = fakeSsh({ dockerInstalled: true, deployedBefore: true });
    const events = [];
    await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), {
      onEvent: (e) => events.push(e),
    });

    const done = (id) => events.find((e) => e.id === id && e.status !== "running").status;
    expect(done("prepare")).toBe("skipped");
    expect(done("stop")).toBe("done");
    expect(scripts.some((s) => s.includes("get.docker.com"))).toBe(false);
    const downs = scripts.filter((s) => s.includes("'down'"));
    expect(downs).toHaveLength(2); // named project + legacy default project
    expect(downs[0]).toContain("'-p' 'demo'");
    expect(downs[1]).not.toContain("'-p'");
    const order = scripts.findIndex((s) => s.includes("'down'"));
    const up = scripts.findIndex((s) => s.includes("'up'"));
    expect(order).toBeLessThan(up);
  });

  test("falls back to sudo docker when the user is not in the docker group yet", async () => {
    const { ssh, scripts } = fakeSsh({ needsSudo: true });
    await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), { onEvent: () => {} });
    expect(scripts.some((s) => s.includes("'sudo' 'docker' 'compose' '-p' 'demo' 'up'"))).toBe(true);
  });

  test("a connection failure aborts with a readable message and uploads nothing", async () => {
    const { ssh } = fakeSsh({ failConnect: true });
    const error = await new DebianUploadStrategy({ sshFactory: () => ssh })
      .deploy(config(), { onEvent: () => {} })
      .catch((e) => e);
    expect(error.message).toMatch(/Could not connect via ssh to deploy@203.0.113.5.*Permission denied/);
    expect(error.step).toBe("connect");
    expect(ssh.upload).not.toHaveBeenCalled();
  });

  test("an unsafe remote path is rejected before anything runs on the server", async () => {
    const { ssh } = fakeSsh();
    await expect(
      new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(
        { ...config(), remoteRepoPath: "/" },
        { onEvent: () => {} },
      ),
    ).rejects.toThrow(/remoteRepoPath/);
    expect(ssh.exec).not.toHaveBeenCalled();
  });
});
