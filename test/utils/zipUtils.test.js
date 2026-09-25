import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { compressFolder, hashFolder, listFiles } from "../../src/utils/zipUtils.js";

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

  test("compressFolder can zip just a list of files", async () => {
    const { files } = await compressFolder(dir, out, { files: ["client/src/main.js"] });
    expect(files).toBe(1);
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    expect(Object.keys(zip.files).filter((n) => !zip.files[n].dir)).toEqual(["client/src/main.js"]);
  });

  test("hashFolder hashes contents, skipping excluded folders", async () => {
    const before = await hashFolder(dir);
    expect(Object.keys(before)).toEqual([
      "client/src/main.js",
      "deploy/docker-compose.yml",
      "deploy/importer/data/layer.zip",
    ]);
    expect(await hashFolder(dir)).toEqual(before);

    fs.writeFileSync(path.join(dir, "client/src/main.js"), "changed");
    const after = await hashFolder(dir);
    expect(after["client/src/main.js"]).not.toBe(before["client/src/main.js"]);
    expect(after["deploy/docker-compose.yml"]).toBe(before["deploy/docker-compose.yml"]);
  });

  test("already compressed files are stored, text is deflated", async () => {
    fs.writeFileSync(path.join(dir, "client/big.txt"), "a".repeat(10000));
    fs.writeFileSync(path.join(dir, "client/pack.zip"), "a".repeat(10000));
    await compressFolder(dir, out, { files: ["client/big.txt", "client/pack.zip"] });
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    expect(zip.file("client/big.txt")._data.compression.magic).toBe("\x08\x00");
    expect(zip.file("client/pack.zip")._data.compression.magic).toBe("\x00\x00");
  });

  test("errors propagate", async () => {
    await expect(compressFolder(path.join(dir, "missing"), out)).rejects.toThrow();
  });
});
