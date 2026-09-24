import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import LocalUploadStrategy from "../../src/strategies/LocalUploadStrategy.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "local-strategy-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const ps = (state = "running", health = "") =>
  JSON.stringify({ Service: "web", Name: "w", State: state, Health: health, ExitCode: 0 });

/** runFn that behaves like a healthy docker; `overrides` maps an argv prefix to a result/throw. */
const fakeRun = (overrides = {}) =>
  vi.fn(async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    for (const [prefix, result] of Object.entries(overrides)) {
      if (line.startsWith(prefix)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    if (line.includes(" ps ")) return { stdout: ps() };
    return { stdout: "" };
  });

describe("LocalUploadStrategy", () => {
  test("runs the four steps in the deploy folder with a project name", async () => {
    const runFn = fakeRun();
    const events = [];
    const result = await new LocalUploadStrategy({ runFn }).deploy(
      { repoPath: repo, projectName: "demo" },
      { onEvent: (e) => events.push(e) },
    );

    expect(result).toEqual({ url: "http://localhost" });
    expect(events.filter((e) => e.type === "step" && e.status === "done").map((e) => e.id)).toEqual([
      "docker",
      "stop",
      "build",
      "wait",
    ]);
    const lines = runFn.mock.calls.map(([c, a]) => [c, ...a].join(" "));
    expect(lines).toContain("docker compose -p demo up -d --build --remove-orphans");
    expect(runFn.mock.calls.every(([, , opts]) => opts.cwd === path.join(repo, "deploy"))).toBe(true);
    expect(events.some((e) => e.type === "services")).toBe(true);
  });

  test("describe() lists the steps before running anything", () => {
    const runFn = fakeRun();
    expect(new LocalUploadStrategy({ runFn }).describe({ repoPath: repo })).toEqual([
      { id: "docker", label: "Check Docker" },
      { id: "stop", label: "Stop previous deployment" },
      { id: "build", label: "Build & start services" },
      { id: "wait", label: "Wait for services" },
    ]);
    expect(runFn).not.toHaveBeenCalled();
  });

  test("uses config.url when given", async () => {
    const result = await new LocalUploadStrategy({ runFn: fakeRun() }).deploy(
      { repoPath: repo, url: "http://localhost:8080" },
      { onEvent: () => {} },
    );
    expect(result.url).toBe("http://localhost:8080");
  });

  test("reports a clear error when Docker is not running", async () => {
    const runFn = fakeRun({ "docker info": new Error("Cannot connect to the Docker daemon") });
    await expect(
      new LocalUploadStrategy({ runFn }).deploy({ repoPath: repo }, { onEvent: () => {} }),
    ).rejects.toThrow(/Docker is not running/);
  });

  test("fails when there is no docker-compose.yml", async () => {
    fs.rmSync(path.join(repo, "deploy", "docker-compose.yml"));
    await expect(
      new LocalUploadStrategy({ runFn: fakeRun() }).deploy({ repoPath: repo }, { onEvent: () => {} }),
    ).rejects.toThrow(/No docker-compose.yml/);
  });

  test("a failing previous-stack cleanup does not abort the deployment", async () => {
    const runFn = fakeRun({ "docker compose down": new Error("no such project") });
    await expect(
      new LocalUploadStrategy({ runFn }).deploy({ repoPath: repo }, { onEvent: () => {} }),
    ).resolves.toMatchObject({ url: "http://localhost" });
  });

  test("a failing `up` includes service diagnostics in the error", async () => {
    const runFn = fakeRun({
      "docker compose up": new Error("dependency failed to start"),
      "docker compose logs": { stdout: "server crashed: OOM" },
    });
    // ps reports an exited (non-zero) service so diagnose() has something to show
    runFn.mockImplementation(async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if (line.includes(" up ")) throw new Error("dependency failed to start");
      if (line.includes(" ps ")) return { stdout: JSON.stringify({ Service: "server", Name: "s", State: "exited", Health: "", ExitCode: 1 }) };
      if (line.includes(" logs ")) return { stdout: "server crashed: OOM" };
      return { stdout: "" };
    });
    await expect(
      new LocalUploadStrategy({ runFn }).deploy({ repoPath: repo }, { onEvent: () => {} }),
    ).rejects.toThrow(/dependency failed to start[\s\S]*server crashed: OOM/);
  });
});
