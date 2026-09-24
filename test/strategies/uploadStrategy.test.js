import { describe, test, expect, vi } from "vitest";
import UploadStrategy from "../../src/strategies/UploadStrategy.js";
import { Compose, parsePs, classify } from "../../src/docker/compose.js";

class FakeStrategy extends UploadStrategy {
  constructor(steps) {
    super();
    this._steps = steps;
  }
  plan() {
    return this._steps;
  }
  resolveUrl(config, state) {
    return `http://${state.host || "h"}`;
  }
}

const collect = () => {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
};

describe("UploadStrategy.deploy", () => {
  test("base plan() must be overwritten", async () => {
    await expect(new UploadStrategy().deploy({}, { onEvent: () => {} })).rejects.toThrow(/overwritten/);
  });

  test("runs steps in order, reports them and returns the url", async () => {
    const { events, onEvent } = collect();
    const strategy = new FakeStrategy([
      { id: "a", label: "A", run: async (ctx) => { ctx.state.host = "srv"; ctx.log("hi"); } },
      { id: "b", label: "B", run: async () => ({ skipped: true, detail: "nothing" }) },
    ]);

    const result = await strategy.deploy({}, { onEvent });

    expect(result).toEqual({ url: "http://srv" });
    expect(events.map((e) => `${e.type}:${e.id || e.step}:${e.status || e.line}`)).toEqual([
      "step:a:running",
      "log:a:hi",
      "step:a:done",
      "step:b:running",
      "step:b:skipped",
    ]);
    expect(events.at(-1)).toMatchObject({ index: 2, total: 2, detail: "nothing" });
  });

  test("a failing step aborts, is reported and tagged on the error", async () => {
    const { events, onEvent } = collect();
    const after = vi.fn();
    const strategy = new FakeStrategy([
      { id: "a", label: "A", run: async () => { throw new Error("nope"); } },
      { id: "b", label: "B", run: after },
    ]);

    const error = await strategy.deploy({}, { onEvent }).catch((e) => e);

    expect(error.message).toBe("nope");
    expect(error.step).toBe("a");
    expect(after).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ id: "a", status: "failed", detail: "nope" });
  });

  test("cleanups run even when a step fails", async () => {
    const cleanup = vi.fn();
    const strategy = new FakeStrategy([
      { id: "a", label: "A", run: async (ctx) => { ctx.onCleanup(cleanup); throw new Error("x"); } },
    ]);
    await expect(strategy.deploy({}, { onEvent: () => {} })).rejects.toThrow("x");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  test("an aborted signal stops before the next step", async () => {
    const controller = new AbortController();
    const second = vi.fn();
    const strategy = new FakeStrategy([
      { id: "a", label: "A", run: async () => controller.abort() },
      { id: "b", label: "B", run: second },
    ]);
    await expect(
      strategy.deploy({}, { onEvent: () => {}, signal: controller.signal }),
    ).rejects.toThrow(/Aborted/);
    expect(second).not.toHaveBeenCalled();
  });

  test("uploadCode() (1.x API) resolves to the url", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const strategy = new FakeStrategy([{ id: "a", label: "A", run: async () => {} }]);
    expect(await strategy.uploadCode({})).toBe("http://h");
    spy.mockRestore();
  });
});

describe("docker compose helpers", () => {
  const ndjson = [
    '{"Service":"db","Name":"app-db","State":"running","Health":"healthy","ExitCode":0}',
    '{"Service":"importer","Name":"app-importer","State":"exited","Health":"","ExitCode":0}',
  ].join("\n");

  test("parsePs reads NDJSON (compose >= 2.21) and JSON arrays", () => {
    const expected = [
      { name: "db", container: "app-db", state: "running", health: "healthy", exitCode: 0 },
      { name: "importer", container: "app-importer", state: "exited", health: "", exitCode: 0 },
    ];
    expect(parsePs(ndjson)).toEqual(expected);
    expect(parsePs(`[${ndjson.split("\n").join(",")}]`)).toEqual(expected);
    expect(parsePs("")).toEqual([]);
  });

  test.each([
    [{ state: "running", health: "", exitCode: 0 }, "ready"],
    [{ state: "running", health: "healthy", exitCode: 0 }, "ready"],
    [{ state: "running", health: "starting", exitCode: 0 }, "pending"],
    [{ state: "running", health: "unhealthy", exitCode: 0 }, "failed"],
    [{ state: "exited", health: "", exitCode: 0 }, "ready"],
    [{ state: "exited", health: "", exitCode: 1 }, "failed"],
    [{ state: "restarting", health: "", exitCode: 0 }, "pending"],
    [{ state: "created", health: "", exitCode: 0 }, "pending"],
  ])("classify %j -> %s", (service, expected) => {
    expect(classify(service)).toBe(expected);
  });

  const psRow = (service, state, health = "", exitCode = 0) =>
    JSON.stringify({ Service: service, Name: `p-${service}`, State: state, Health: health, ExitCode: exitCode });

  const composeWith = (responses) => {
    const calls = [];
    const exec = vi.fn(async (argv) => {
      calls.push(argv);
      if (argv.includes("ps")) return { stdout: responses.shift() ?? "" };
      if (argv.includes("logs")) return { stdout: "last log line" };
      return { stdout: "" };
    });
    return { compose: new Compose({ exec, prefix: ["docker", "compose"], projectName: "p" }), calls };
  };

  test("waitForServices polls until everything is ready", async () => {
    const { compose } = composeWith([
      [psRow("db", "running", "starting"), psRow("web", "created")].join("\n"),
      [psRow("db", "running", "healthy"), psRow("web", "running")].join("\n"),
    ]);
    const seen = [];
    const result = await compose.waitForServices({
      pollMs: 0,
      sleepFn: async () => {},
      onStatus: (s) => seen.push(s.map((x) => x.status)),
    });
    expect(seen).toEqual([["pending", "pending"], ["ready", "ready"]]);
    expect(result).toHaveLength(2);
  });

  test("waitForServices fails fast on an unhealthy service and includes its logs", async () => {
    const { compose } = composeWith([
      psRow("db", "running", "unhealthy"),
      psRow("db", "running", "unhealthy"),
    ]);
    await expect(
      compose.waitForServices({ pollMs: 0, sleepFn: async () => {} }),
    ).rejects.toThrow(/db[\s\S]*last log line/);
  });

  test("waitForServices times out naming the pending services", async () => {
    const rows = psRow("web", "created");
    const { compose } = composeWith([rows, rows, rows, rows]);
    await expect(
      compose.waitForServices({ timeoutMs: -1, pollMs: 0, sleepFn: async () => {} }),
    ).rejects.toThrow(/Timed out waiting for services: web/);
  });

  test("commands use the project name and prefix", async () => {
    const { compose, calls } = composeWith([]);
    await compose.up();
    await compose.down();
    expect(calls[0]).toEqual(["docker", "compose", "-p", "p", "up", "-d", "--build", "--remove-orphans"]);
    expect(calls[1]).toEqual(["docker", "compose", "-p", "p", "down", "-v", "--remove-orphans"]);
  });

  test("detectPrefix falls back to docker-compose and sudo", async () => {
    const exec = vi.fn(async (argv) => {
      if (argv.join(" ") === "sudo docker-compose version") return {};
      throw new Error("no");
    });
    expect(await Compose.detectPrefix(exec, { sudo: true })).toEqual(["sudo", "docker-compose"]);
    expect(await Compose.detectPrefix(async () => { throw new Error("no"); })).toBeNull();
  });
});
