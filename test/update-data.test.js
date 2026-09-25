import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import LocalUploadStrategy from "../src/strategies/LocalUploadStrategy.js";
import DebianUploadStrategy from "../src/strategies/DebianUploadStrategy.js";
import UploadStrategy from "../src/strategies/UploadStrategy.js";
import { Compose } from "../src/docker/compose.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "update-data-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const row = (service, state, extra = {}) =>
  JSON.stringify({ Service: service, Name: `p-${service}`, State: state, Health: "", ExitCode: 0, ...extra });

const IMPORTER_LABELS = { Labels: "gp.oneshot=true" };

describe("Compose.up with services", () => {
  test("recreates only those services, with no deps and no build on request", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    await new Compose({ exec, prefix: ["docker", "compose"], projectName: "demo" }).up({
      services: ["data-importer"],
      build: false,
    });
    expect(exec.mock.calls[0][0]).toEqual([
      "docker", "compose", "-p", "demo", "up", "-d", "--no-deps", "--force-recreate", "data-importer",
    ]);
  });

  test("plain up is unchanged", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    await new Compose({ exec, prefix: ["docker", "compose"] }).up();
    expect(exec.mock.calls[0][0]).toEqual(["docker", "compose", "up", "-d", "--build", "--remove-orphans"]);
  });
});

describe("Compose.waitForServices with services", () => {
  test("ignores the rest of the stack", async () => {
    const exec = vi.fn(async () => ({
      stdout: [row("data-importer", "exited", IMPORTER_LABELS), row("server", "restarting")].join("\n"),
    }));
    const compose = new Compose({ exec, prefix: ["docker", "compose"] });
    const report = await compose.waitForServices({ services: ["data-importer"], sleepFn: async () => {} });
    expect(report.map((s) => s.name)).toEqual(["data-importer"]);
  });

  test("a failed importer fails the wait even if the server is fine", async () => {
    const exec = vi.fn(async () => ({
      stdout: [row("data-importer", "exited", { ...IMPORTER_LABELS, ExitCode: 1 }), row("server", "running")].join("\n"),
    }));
    const compose = new Compose({ exec, prefix: ["docker", "compose"] });
    await expect(compose.waitForServices({ services: ["data-importer"], sleepFn: async () => {} })).rejects.toThrow(
      /data-importer/,
    );
  });

  test("notRunning lists what is not running", async () => {
    const exec = vi.fn(async () => ({ stdout: [row("server", "running"), row("data-importer", "exited")].join("\n") }));
    const compose = new Compose({ exec, prefix: ["docker", "compose"] });
    expect(await compose.notRunning(["server", "data-importer", "gone"])).toEqual(["data-importer", "gone"]);
  });
});

describe("LocalUploadStrategy.updateData", () => {
  const fakeRun = ({ serverRunning = true } = {}) =>
    vi.fn(async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if (line.includes(" ps ")) {
        return {
          stdout: [
            serverRunning ? row("server", "running") : row("server", "exited"),
            row("data-importer", "exited", IMPORTER_LABELS),
          ].join("\n"),
        };
      }
      return { stdout: "" };
    });

  test("runs only the importer: no down, no build", async () => {
    const runFn = fakeRun();
    const events = [];
    const result = await new LocalUploadStrategy({ runFn }).updateData(
      { repoPath: repo, projectName: "demo" },
      { onEvent: (e) => events.push(e) },
    );
    const lines = runFn.mock.calls.map(([c, a]) => [c, ...a].join(" "));
    expect(lines).toContain("docker compose -p demo up -d --no-deps --force-recreate data-importer");
    expect(lines.some((l) => l.includes(" down"))).toBe(false);
    expect(lines.some((l) => l.includes("--build"))).toBe(false);
    expect(events.filter((e) => e.type === "step" && e.status === "done").map((e) => e.id)).toEqual([
      "docker",
      "import",
      "wait",
    ]);
    expect(result).toEqual({ url: "http://localhost" });
  });

  test("says to deploy first when the server is not running", async () => {
    await expect(
      new LocalUploadStrategy({ runFn: fakeRun({ serverRunning: false }) }).updateData(
        { repoPath: repo, projectName: "demo" },
        { onEvent: () => {} },
      ),
    ).rejects.toThrow(/deploy it first/);
  });

  test("describeUpdate lists the steps without running anything", () => {
    const runFn = fakeRun();
    expect(new LocalUploadStrategy({ runFn }).describeUpdate({ repoPath: repo })).toEqual([
      { id: "docker", label: "Check Docker" },
      { id: "import", label: "Load the data" },
      { id: "wait", label: "Wait for the import" },
    ]);
    expect(runFn).not.toHaveBeenCalled();
  });
});

describe("DebianUploadStrategy.updateData", () => {
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

  const fakeSsh = ({ deployed = true, serverRunning = true, remoteManifest = {} } = {}) => {
    const scripts = [];
    const ssh = {
      exec: vi.fn(async (script) => {
        scripts.push(script);
        if (script.includes(".gp-manifest.json' 2>/dev/null")) {
          return { stdout: remoteManifest ? JSON.stringify({ version: 1, files: remoteManifest }) : "" };
        }
        if (script.includes("&& echo YES")) return { stdout: deployed ? "YES\n" : "NO\n" };
        if (script.includes("'ps'")) {
          return {
            stdout: [
              serverRunning ? row("server", "running") : row("server", "exited"),
              row("data-importer", "exited", IMPORTER_LABELS),
            ].join("\n"),
          };
        }
        return { stdout: "" };
      }),
      upload: vi.fn(async () => {}),
    };
    return { ssh, scripts };
  };

  test("uploads the data and runs only the importer, never installing docker", async () => {
    const { ssh, scripts } = fakeSsh();
    const result = await new DebianUploadStrategy({ sshFactory: () => ssh }).updateData(config(), {
      onEvent: () => {},
    });
    expect(result).toEqual({ url: "http://203.0.113.5" });
    expect(scripts.some((s) => s.includes("get.docker.com"))).toBe(false);
    expect(scripts.some((s) => s.includes("'down'"))).toBe(false);
    expect(
      scripts.some((s) => s.includes("'--no-deps'") && s.includes("'--force-recreate'") && s.includes("'data-importer'")),
    ).toBe(true);
  });

  test("refuses to update an empty server folder", async () => {
    const { ssh } = fakeSsh({ deployed: false });
    await expect(
      new DebianUploadStrategy({ sshFactory: () => ssh }).updateData(config(), { onEvent: () => {} }),
    ).rejects.toThrow(/deploy the app first/);
  });

  test("says to deploy first when the server is down", async () => {
    const { ssh } = fakeSsh({ serverRunning: false });
    await expect(
      new DebianUploadStrategy({ sshFactory: () => ssh }).updateData(config(), { onEvent: () => {} }),
    ).rejects.toThrow(/not running on the server/);
  });

  test("describeUpdate lists the ssh steps", () => {
    const { ssh } = fakeSsh();
    expect(new DebianUploadStrategy({ sshFactory: () => ssh }).describeUpdate(config()).map((s) => s.id)).toEqual([
      "connect",
      "check",
      "package",
      "upload",
      "import",
      "wait",
    ]);
  });
});

describe("a strategy without an update plan", () => {
  test("says so", async () => {
    class Plain extends UploadStrategy {
      plan() {
        return [];
      }
    }
    await expect(new Plain().updateData({})).rejects.toThrow(/cannot update the data/);
  });
});
