import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import DebianUploadStrategy from "../../src/strategies/DebianUploadStrategy.js";
import { withRemoteEnv } from "../../src/strategies/RemoteStrategy.js";
import { hashFolder } from "../../src/utils/zipUtils.js";

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
const fakeSsh = ({
  dockerInstalled = true,
  deployedBefore = false,
  needsSudo = false,
  failConnect = false,
  remoteManifest = null,
} = {}) => {
  const scripts = [];
  const uploads = [];
  const ssh = {
    exec: vi.fn(async (script) => {
      scripts.push(script);
      if (script.includes(".gp-manifest.json' 2>/dev/null")) {
        return { stdout: remoteManifest ? JSON.stringify({ version: 1, files: remoteManifest }) : "" };
      }
      if (failConnect) throw Object.assign(new Error("ssh failed"), { tail: () => "Permission denied (publickey)" });
      if (script.includes("echo READY")) return { stdout: dockerInstalled ? "READY\n" : "MISSING\n" };
      if (script.includes("&& echo YES")) return { stdout: deployedBefore ? "YES\n" : "NO\n" };
      if (script.startsWith("docker info") && needsSudo) throw new Error("permission denied");
      if (script.includes("'ps'")) return { stdout: READY_ROW };
      return { stdout: "" };
    }),
    // the temp zip is deleted after the deploy: read what it held while it exists
    upload: vi.fn(async (zipPath, ...rest) => {
      const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
      uploads.push([zipPath, ...rest, names]);
    }),
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
    // the database survives a redeploy
    expect(downs.every((d) => !d.includes("'-v'"))).toBe(true);
    const order = scripts.findIndex((s) => s.includes("'down'"));
    const up = scripts.findIndex((s) => s.includes("'up'"));
    expect(order).toBeLessThan(up);
  });

  test("falls back to sudo docker when the user is not in the docker group yet", async () => {
    const { ssh, scripts } = fakeSsh({ needsSudo: true });
    await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), { onEvent: () => {} });
    expect(scripts.some((s) => s.includes("'sudo' 'env' 'DOCKER_BUILDKIT=1' 'COMPOSE_DOCKER_CLI_BUILD=1' 'docker' 'compose' '-p' 'demo' 'up'"))).toBe(true);
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

  test("resetData deletes the volumes of the previous stack", async () => {
    const { ssh, scripts } = fakeSsh({ deployedBefore: true });
    await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(
      { ...config(), resetData: true },
      { onEvent: () => {} },
    );
    const downs = scripts.filter((s) => s.includes("'down'"));
    expect(downs).toHaveLength(2);
    expect(downs.every((d) => d.includes("'down' '-v' '--remove-orphans'"))).toBe(true);
  });

  describe("incremental upload", () => {
    const write = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), content);
    };

    test("first deploy is full: wipes the folder, sends every file, then writes the manifest", async () => {
      write("client/src/main.js", "a");
      const { ssh, scripts, uploads } = fakeSsh();
      await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), { onEvent: () => {} });

      expect(uploads[0].at(-1)).toEqual(["client/src/main.js", "deploy/docker-compose.yml"]);
      expect(scripts.some((s) => s.includes("-mindepth 1 -delete"))).toBe(true);
      const manifestWrite = scripts.find((s) => s.includes("GP_MANIFEST_EOF"));
      const written = JSON.parse(manifestWrite.split("\n").at(-2));
      expect(Object.keys(written.files).sort()).toEqual(["client/src/main.js", "deploy/docker-compose.yml"]);
      expect(manifestWrite).toContain('cat > "$DIR"/.gp-manifest.json');
    });

    test("redeploy sends only the changed files, keeps the folder and removes deleted files", async () => {
      write("client/src/main.js", "a");
      write("data/big.zip", "unchanged data");
      const before = await hashFolder(repo);
      write("client/src/main.js", "changed");
      write("client/src/new.js", "new");
      const remoteManifest = { ...before, "old/gone.js": "x".repeat(64), "../evil": "y" };

      const { ssh, scripts, uploads } = fakeSsh({ remoteManifest });
      const events = [];
      await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), {
        onEvent: (e) => events.push(e),
      });

      expect(uploads[0].at(-1)).toEqual(["client/src/main.js", "client/src/new.js"]);
      expect(scripts.some((s) => s.includes("-mindepth 1 -delete"))).toBe(false);
      // stale manifest removed first, deleted file removed, an unsafe path never reaches rm
      const prepare = scripts.find((s) => s.includes('rm -f "$DIR"/.gp-manifest.json'));
      expect(prepare).toContain("rm -f -- 'old/gone.js'");
      expect(scripts.some((s) => s.includes("evil"))).toBe(false);
      expect(events.some((e) => e.type === "log" && /Incremental upload: 2 of 4 files/.test(e.line))).toBe(true);
    });

    test("nothing changed: no upload at all, the manifest is still rewritten", async () => {
      write("client/src/main.js", "a");
      const remoteManifest = await hashFolder(repo);
      const { ssh, scripts } = fakeSsh({ remoteManifest });
      await new DebianUploadStrategy({ sshFactory: () => ssh }).deploy(config(), { onEvent: () => {} });

      expect(ssh.upload).not.toHaveBeenCalled();
      expect(scripts.some((s) => s.includes("unzip"))).toBe(false);
      expect(scripts.some((s) => s.includes("GP_MANIFEST_EOF"))).toBe(true);
    });
  });

  test("withRemoteEnv puts the variables after sudo", () => {
    expect(withRemoteEnv(["docker", "compose", "up"])).toBe("'docker' 'compose' 'up'");
    expect(withRemoteEnv(["docker", "up"], { A: "1" })).toBe("'env' 'A=1' 'docker' 'up'");
    expect(withRemoteEnv(["sudo", "docker", "up"], { A: "1" })).toBe("'sudo' 'env' 'A=1' 'docker' 'up'");
  });
});
