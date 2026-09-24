import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { compressFolder, listFiles } from "../../src/utils/zipUtils.js";

let dir;
let out;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-src-"));
  out = path.join(os.tmpdir(), `zip-out-${Date.now()}-${Math.random()}.zip`);
  const write = (rel, content = "x") => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("deploy/docker-compose.yml", "services: {}");
  write("deploy/importer/data/layer.zip", "PK-not-really");
  write("client/src/main.js");
  write("client/node_modules/dep/index.js");
  write(".git/config");
  write("server/.gradle/x");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { force: true });
});

describe("zipUtils", () => {
  test("listFiles skips excluded folders at any depth, keeps .zip data", async () => {
    const files = (await listFiles(dir)).sort();
    expect(files).toEqual([
      "client/src/main.js",
      "deploy/docker-compose.yml",
      "deploy/importer/data/layer.zip",
    ]);
  });

  test("compressFolder writes a readable archive with posix paths", async () => {
    const { files, bytes } = await compressFolder(dir, out);
    expect(files).toBe(3);
    expect(bytes).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual([
      "client/src/main.js",
      "deploy/docker-compose.yml",
      "deploy/importer/data/layer.zip",
    ]);
    expect(await zip.file("deploy/docker-compose.yml").async("string")).toBe("services: {}");
  });

  test("errors propagate", async () => {
    await expect(compressFolder(path.join(dir, "missing"), out)).rejects.toThrow();
  });
});
