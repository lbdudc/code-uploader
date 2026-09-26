import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import PackageStrategy from "../../src/strategies/PackageStrategy.js";

let dir;
let repo;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-strategy-"));
  repo = path.join(dir, "output");
  fs.mkdirSync(path.join(repo, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(repo, "server"), { recursive: true });
  fs.mkdirSync(path.join(repo, "client", "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
  fs.writeFileSync(path.join(repo, "deploy", ".env"), "A=1");
  fs.writeFileSync(path.join(repo, "server", "gradlew"), "#!/bin/sh");
  // left by a deployment made from the same folder
  fs.writeFileSync(path.join(repo, ".gp-deploy-state.json"), "{}");
  fs.writeFileSync(path.join(repo, ".gp-manifest.json"), "{}");
  fs.writeFileSync(path.join(repo, "client", "node_modules", "x", "i.js"), "x");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const entries = async (file) => {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return zip;
};

describe("PackageStrategy", () => {
  test("zips the app under a folder with the extra files, and reports the file, not a URL", async () => {
    const file = path.join(dir, "out", "demo-1.0.0.zip");
    const events = [];
    const result = await new PackageStrategy().deploy(
      {
        type: "package",
        repoPath: repo,
        file,
        name: "demo",
        extraFiles: { "README.md": "# demo", "start.sh": "#!/bin/sh\necho hi" },
      },
      { onEvent: (e) => events.push(e) },
    );

    expect(result).toEqual({ url: null, file });
    const zip = await entries(file);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual([
      "demo/README.md",
      "demo/deploy/.env",
      "demo/deploy/docker-compose.yml",
      "demo/server/gradlew",
      "demo/start.sh",
    ]);
    expect(await zip.file("demo/README.md").async("string")).toBe("# demo");
    expect(names.some((n) => n.includes(".gp-"))).toBe(false);
    expect(events.find((e) => e.id === "package" && e.status === "done").detail).toMatch(/5 files/);
  });

  test("scripts keep the executable bit, other files do not", async () => {
    const file = path.join(dir, "p.zip");
    await new PackageStrategy().deploy(
      { type: "package", repoPath: repo, file, name: "demo", extraFiles: { "start.sh": "#!/bin/sh" } },
      { onEvent: () => {} },
    );
    const zip = await entries(file);
    expect(zip.file("demo/start.sh").unixPermissions & 0o777).toBe(0o755);
    expect(zip.file("demo/server/gradlew").unixPermissions & 0o777).toBe(0o755);
    expect(zip.file("demo/deploy/.env").unixPermissions & 0o777).toBe(0o644);
  });

  test("an existing file is replaced and a missing folder or file setting is an error", async () => {
    const file = path.join(dir, "p.zip");
    fs.writeFileSync(file, "old");
    await new PackageStrategy().deploy({ type: "package", repoPath: repo, file, name: "d" }, { onEvent: () => {} });
    expect(fs.readFileSync(file).slice(0, 2).toString()).toBe("PK");

    await expect(
      new PackageStrategy().deploy({ type: "package", repoPath: path.join(dir, "nope"), file }, { onEvent: () => {} }),
    ).rejects.toThrow(/Folder not found/);
    await expect(
      new PackageStrategy().deploy({ type: "package", repoPath: repo }, { onEvent: () => {} }),
    ).rejects.toThrow(/"file"/);
  });

  test("describe lists the single step", () => {
    expect(new PackageStrategy().describe({ type: "package" })).toEqual([
      { id: "package", label: "Create the zip" },
    ]);
  });
});
