import { describe, test, expect } from "vitest";
import path from "path";
import { run, CommandError } from "../../src/utils/exec.js";
import { shQuote, formatDuration, getAbsolutePath } from "../../src/utils/utils.js";

const node = process.execPath;

describe("utils", () => {
  test("shQuote escapes single quotes", () => {
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("formatDuration", () => {
    expect(formatDuration(4200)).toBe("4s");
    expect(formatDuration(184000)).toBe("3m 04s");
  });

  test("getAbsolutePath keeps absolute paths and resolves relative ones", () => {
    const abs = path.resolve("/tmp/x");
    expect(getAbsolutePath(abs)).toBe(abs);
    expect(path.isAbsolute(getAbsolutePath("out"))).toBe(true);
  });
});

describe("run()", () => {
  test("resolves with stdout and streams complete lines", async () => {
    const lines = [];
    const result = await run(
      node,
      ["-e", "process.stdout.write('one\\ntwo\\nthr'); process.stdout.write('ee\\n')"],
      { onLine: (l) => lines.push(l) },
    );
    expect(result.code).toBe(0);
    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("rejects with a CommandError on non-zero exit", async () => {
    const error = await run(node, ["-e", "console.error('boom'); process.exit(3)"]).catch((e) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect(error.code).toBe(3);
    expect(error.tail()).toContain("boom");
    // the reason travels with the message, not just the exit code
    expect(error.message).toMatch(/exit 3[\s\S]*boom/);
  });

  test("rejects when the command does not exist", async () => {
    await expect(run("definitely-not-a-command-xyz", [])).rejects.toThrow(/not found/i);
  });

  test("timeout kills the process and rejects", async () => {
    const started = Date.now();
    await expect(
      run(node, ["-e", "setTimeout(()=>{}, 30000)"], { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  test("abort signal kills the process and rejects", async () => {
    const controller = new AbortController();
    const promise = run(node, ["-e", "setTimeout(()=>{}, 30000)"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(promise).rejects.toThrow(/Aborted/);
  });

  test("already aborted signal rejects without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(node, ["-e", ""], { signal: controller.signal })).rejects.toThrow(/Aborted/);
  });

  test("input is written to stdin", async () => {
    const result = await run(
      node,
      ["-e", "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))"],
      { input: "hello" },
    );
    expect(result.stdout).toBe("HELLO");
  });

  test("arguments are not interpreted by a shell", async () => {
    const result = await run(node, ["-e", "console.log(process.argv[1])", "a b; echo hacked"]);
    expect(result.stdout.trim()).toBe("a b; echo hacked");
  });
});
