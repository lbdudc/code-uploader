import { describe, test, expect, vi } from "vitest";
import Uploader from "../src/Uploader.js";
import { normalizeConfig, assertSafeRemotePath } from "../src/config.js";
import { SSHClient } from "../src/ssh.js";

describe("Uploader", () => {
  test("delegates deploy/uploadCode to the strategy", async () => {
    const strategy = {
      deploy: vi.fn().mockResolvedValue({ url: "http://x" }),
      uploadCode: vi.fn().mockResolvedValue("http://x"),
    };
    const uploader = new Uploader();
    uploader.setUploadStrategy(strategy);

    expect(await uploader.deploy({ a: 1 }, { onEvent: 1 })).toEqual({ url: "http://x" });
    expect(strategy.deploy).toHaveBeenCalledWith({ a: 1 }, { onEvent: 1 });
    expect(await uploader.uploadCode({ a: 1 })).toBe("http://x");
  });

  test("createInstance fails clearly for strategies that cannot", async () => {
    const uploader = new Uploader();
    uploader.setUploadStrategy({});
    await expect(uploader.createInstance({})).rejects.toThrow(/cannot create instances/);
  });
});

describe("normalizeConfig", () => {
  test("maps the AWS_* keys the QGIS plugin sends", () => {
    const config = normalizeConfig({
      type: "aws",
      AWS_USERNAME: "ec2-user",
      AWS_SSH_PRIVATE_KEY_PATH: "/k.pem",
      REMOTE_REPO_PATH: "/home/ec2-user/app",
      AWS_REGION: "eu-west-2",
    });
    expect(config).toMatchObject({
      username: "ec2-user",
      certRoute: "/k.pem",
      remoteRepoPath: "/home/ec2-user/app",
      awsRegion: "eu-west-2",
      port: 22,
    });
  });

  test("explicit keys win and port is numeric", () => {
    const config = normalizeConfig({ username: "me", AWS_USERNAME: "x", port: "2222" });
    expect(config.username).toBe("me");
    expect(config.port).toBe(2222);
  });
});

describe("assertSafeRemotePath", () => {
  test.each(["/home/u/app", "/opt/gis-app_1.0"])("accepts %s", (p) => {
    expect(() => assertSafeRemotePath(p)).not.toThrow();
  });

  test.each(["", "/", "~", "~/app", "app", "/home", "/home/u/../..", "/a b/c", "/x/$(rm)", "/x/'y'"])(
    "rejects %j",
    (p) => {
      expect(() => assertSafeRemotePath(p)).toThrow();
    },
  );
});

describe("SSHClient", () => {
  const ssh = new SSHClient({ host: "h", port: 2200, username: "u", identityFile: "/k" });

  test("ssh args never prompt and run bash -s", () => {
    const args = ssh.sshArgs();
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(-3)).toEqual(["u@h", "bash", "-s"]);
    expect(args).toEqual(expect.arrayContaining(["-i", "/k", "-p", "2200"]));
  });

  test("scp uses -P and targets the remote dir", () => {
    const args = ssh.scpArgs("/tmp/a.zip", "/home/u/app");
    expect(args).toEqual(expect.arrayContaining(["-P", "2200"]));
    expect(args.slice(-2)).toEqual(["/tmp/a.zip", "u@h:/home/u/app/"]);
  });

  test("exec sends the script on stdin with strict mode", async () => {
    const runFn = vi.fn().mockResolvedValue({ stdout: "" });
    await new SSHClient({ host: "h", username: "u", runFn }).exec("echo hi");
    const [cmd, , opts] = runFn.mock.calls[0];
    expect(cmd).toBe("ssh");
    expect(opts.input).toBe("set -euo pipefail\necho hi\n");
  });
});
