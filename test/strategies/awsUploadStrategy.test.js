import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import AWSUploadStrategy from "../../src/strategies/AWSUploadStrategy.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "aws-strategy-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const READY_ROW = JSON.stringify({ Service: "web", Name: "w", State: "running", Health: "healthy", ExitCode: 0 });

describe("AWSUploadStrategy", () => {
  // The exact keys the QGIS plugin writes (core/deploy_config.py)
  const pluginConfig = () => ({
    type: "aws",
    host: "198.51.100.7",
    AWS_USERNAME: "ec2-user",
    AWS_SSH_PRIVATE_KEY_PATH: "/k.pem",
    REMOTE_REPO_PATH: "/home/ec2-user/code",
    repoPath: repo,
  });

  test("works with the AWS_* keys the plugin sends and skips creation when a host is given", async () => {
    const seen = [];
    const ssh = {
      exec: vi.fn(async (script) => {
        if (script.includes("echo READY")) return { stdout: "READY" };
        if (script.includes("&& echo YES")) return { stdout: "NO" };
        if (script.includes("'ps'")) return { stdout: READY_ROW };
        return { stdout: "" };
      }),
      upload: vi.fn(async () => {}),
    };
    const strategy = new AWSUploadStrategy({
      sshFactory: (opts) => (seen.push(opts), ssh),
    });
    const events = [];
    const result = await strategy.deploy(pluginConfig(), { onEvent: (e) => events.push(e) });

    expect(seen[0]).toEqual({
      host: "198.51.100.7",
      port: 22,
      username: "ec2-user",
      identityFile: "/k.pem",
    });
    expect(ssh.upload.mock.calls[0][1]).toBe("/home/ec2-user/code");
    expect(events.find((e) => e.id === "instance" && e.status === "skipped")).toBeTruthy();
    expect(result.url).toBe("http://198.51.100.7");
    expect(strategy.getURL()).toBe("http://198.51.100.7");
  });

  test("has an instance step first and retries the first connection", () => {
    const strategy = new AWSUploadStrategy();
    expect(strategy.plan({}).map((s) => s.id)[0]).toBe("instance");
    expect(strategy.connectRetries()).toBeGreaterThan(0);
  });

  test("retries ssh until the fresh instance answers", async () => {
    let attempts = 0;
    const ssh = {
      exec: vi.fn(async (script) => {
        if (script === "true" && ++attempts < 3) throw new Error("Connection refused");
        if (script.includes("echo READY")) return { stdout: "READY" };
        if (script.includes("&& echo YES")) return { stdout: "NO" };
        if (script.includes("'ps'")) return { stdout: READY_ROW };
        return { stdout: "" };
      }),
      upload: vi.fn(async () => {}),
    };
    const strategy = new AWSUploadStrategy({ sshFactory: () => ssh, sleepFn: async () => {} });
    await strategy.deploy(pluginConfig(), { onEvent: () => {} });
    expect(attempts).toBe(3);
  });
});
