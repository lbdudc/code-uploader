import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import DebianUploadStrategy from "../../src/strategies/DebianUploadStrategy.js";
import AWSUploadStrategy from "../../src/strategies/AWSUploadStrategy.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "domain-strategy-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const READY_ROW = JSON.stringify({ Service: "web", Name: "w", State: "running", Health: "healthy", ExitCode: 0 });

const fakeSsh = () => ({
  exec: vi.fn(async (script) => {
    if (script.includes("echo READY")) return { stdout: "READY\n" };
    if (script.includes("&& echo YES")) return { stdout: "NO\n" };
    if (script.includes("'ps'")) return { stdout: READY_ROW };
    return { stdout: "" };
  }),
  upload: vi.fn(async () => {}),
});

const sshConfig = (extra = {}) => ({
  type: "ssh",
  host: "203.0.113.5",
  username: "deploy",
  certRoute: "/k",
  remoteRepoPath: "/home/deploy/app",
  repoPath: repo,
  domain: "gis.example.org",
  ...extra,
});

// what the name resolves to
const dnsOf = (table) => async (name) => {
  if (!table[name]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return table[name];
};

const openPorts = [80, 443].map((port) => ({
  IpProtocol: "tcp",
  FromPort: port,
  ToPort: port,
  IpRanges: [{ CidrIp: "0.0.0.0/0" }],
}));

describe("deploying with a domain", () => {
  test("adds a domain step only when a domain is configured", () => {
    const strategy = new DebianUploadStrategy();
    expect(strategy.plan(sshConfig()).map((s) => s.id)).toContain("domain");
    expect(strategy.plan({ ...sshConfig(), domain: undefined }).map((s) => s.id)).not.toContain("domain");
    expect(strategy.plan().map((s) => s.id)).not.toContain("domain");
    // it comes before anything is uploaded or built
    const ids = strategy.plan(sshConfig()).map((s) => s.id);
    expect(ids.indexOf("domain")).toBeLessThan(ids.indexOf("connect"));
  });

  test("a domain that points at the server passes, and the app answers over HTTPS", async () => {
    const strategy = new DebianUploadStrategy({
      sshFactory: () => fakeSsh(),
      lookupFn: dnsOf({ "gis.example.org": ["203.0.113.5"], "203.0.113.5": ["203.0.113.5"] }),
    });
    const events = [];
    const result = await strategy.deploy(sshConfig(), { onEvent: (e) => events.push(e) });
    expect(result.url).toBe("https://gis.example.org");
    const step = events.find((e) => e.id === "domain" && e.status === "done");
    expect(step.detail).toBe("gis.example.org points to 203.0.113.5");
  });

  test("a domain pointing somewhere else stops the deployment before connecting", async () => {
    const ssh = fakeSsh();
    const strategy = new DebianUploadStrategy({
      sshFactory: () => ssh,
      lookupFn: dnsOf({ "gis.example.org": ["198.51.100.9"], "203.0.113.5": ["203.0.113.5"] }),
    });
    const events = [];
    await expect(strategy.deploy(sshConfig(), { onEvent: (e) => events.push(e) })).rejects.toThrow(
      /gis\.example\.org points to 198\.51\.100\.9, not to the server \(203\.0\.113\.5\)/,
    );
    expect(events.find((e) => e.id === "domain" && e.status === "failed")).toBeTruthy();
    expect(ssh.exec).not.toHaveBeenCalled();
  });

  test("a domain that does not exist yet says so", async () => {
    const strategy = new DebianUploadStrategy({
      sshFactory: () => fakeSsh(),
      lookupFn: dnsOf({ "203.0.113.5": ["203.0.113.5"] }),
    });
    await expect(strategy.deploy(sshConfig(), { onEvent: () => {} })).rejects.toThrow(/does not point anywhere yet/);
  });

  test("a host given by name is compared by its addresses", async () => {
    const strategy = new DebianUploadStrategy({
      sshFactory: () => fakeSsh(),
      lookupFn: dnsOf({ "gis.example.org": ["203.0.113.5"], "server.lan": ["10.0.0.5", "203.0.113.5"] }),
    });
    await expect(
      strategy.deploy(sshConfig({ host: "server.lan" }), { onEvent: () => {} }),
    ).resolves.toEqual({ url: "https://gis.example.org" });
  });

  test("an explicit url wins over the domain", async () => {
    const strategy = new DebianUploadStrategy({
      sshFactory: () => fakeSsh(),
      lookupFn: dnsOf({ "gis.example.org": ["203.0.113.5"], "203.0.113.5": ["203.0.113.5"] }),
    });
    const result = await strategy.deploy(sshConfig({ url: "https://other.example.org" }), { onEvent: () => {} });
    expect(result.url).toBe("https://other.example.org");
  });

  test("on a server the deployment just created, a wrong domain is only a warning", async () => {
    const ssh = fakeSsh();
    const ec2 = {
      send: vi.fn(async (command) => {
        const name = command.constructor.name;
        if (name === "DescribeSecurityGroupsCommand") return { SecurityGroups: [{ IpPermissions: openPorts }] };
        if (name === "RunInstancesCommand") return { Instances: [{ InstanceId: "i-1" }] };
        if (name === "DescribeInstancesCommand") return { Reservations: [{ Instances: [{ PublicIpAddress: "198.51.100.7" }] }] };
        return { Instances: [{ State: { Name: "running" } }], Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
      }),
    };
    const strategy = new AWSUploadStrategy({
      sshFactory: () => ssh,
      ec2Factory: () => ec2,
      lookupFn: dnsOf({ "198.51.100.7": ["198.51.100.7"] }),
    });
    vi.spyOn(strategy, "createInstance").mockResolvedValue("198.51.100.7");
    const events = [];
    const result = await strategy.deploy(
      {
        type: "aws",
        AWS_USERNAME: "ec2-user",
        AWS_SSH_PRIVATE_KEY_PATH: "/k.pem",
        REMOTE_REPO_PATH: "/home/ec2-user/code",
        AWS_SECURITY_GROUP_ID: "sg-1",
        repoPath: repo,
        domain: "gis.example.org",
      },
      { onEvent: (e) => events.push(e) },
    );
    expect(result.url).toBe("https://gis.example.org");
    expect(events.some((e) => e.type === "log" && /Warning: .*does not point anywhere yet/.test(e.line))).toBe(true);
    expect(events.find((e) => e.id === "domain" && e.status === "done")).toBeTruthy();
  });

  test("a host given for an AWS deployment is not a new server: a wrong domain fails", async () => {
    const strategy = new AWSUploadStrategy({
      sshFactory: () => fakeSsh(),
      ec2Factory: () => ({ send: async () => ({ SecurityGroups: [{ IpPermissions: openPorts }] }) }),
      lookupFn: dnsOf({ "gis.example.org": ["198.51.100.9"], "198.51.100.7": ["198.51.100.7"] }),
    });
    await expect(
      strategy.deploy(
        {
          type: "aws",
          host: "198.51.100.7",
          AWS_USERNAME: "ec2-user",
          AWS_SSH_PRIVATE_KEY_PATH: "/k.pem",
          REMOTE_REPO_PATH: "/home/ec2-user/code",
          AWS_SECURITY_GROUP_ID: "sg-1",
          repoPath: repo,
          domain: "gis.example.org",
        },
        { onEvent: () => {} },
      ),
    ).rejects.toThrow(/not to the server/);
  });

  describe("AWS firewall check", () => {
    const awsConfig = () => ({
      type: "aws",
      AWS_USERNAME: "ec2-user",
      AWS_SSH_PRIVATE_KEY_PATH: "/k.pem",
      REMOTE_REPO_PATH: "/home/ec2-user/code",
      AWS_SECURITY_GROUP_ID: "sg-1",
      repoPath: repo,
      domain: "gis.example.org",
    });
    const groupWith = (IpPermissions) => ({
      send: vi.fn(async () => ({ SecurityGroups: [{ IpPermissions }] })),
    });
    const tcp = (from, to, cidr = "0.0.0.0/0") => ({
      IpProtocol: "tcp",
      FromPort: from,
      ToPort: to,
      IpRanges: [{ CidrIp: cidr }],
    });

    test("is the first step, and only with a domain", () => {
      const strategy = new AWSUploadStrategy();
      expect(strategy.plan(awsConfig()).map((s) => s.id).slice(0, 3)).toEqual(["firewall", "instance", "domain"]);
      expect(strategy.plan({ ...awsConfig(), domain: undefined }).map((s) => s.id)).not.toContain("firewall");
    });

    test("passes when 80 and 443 are open to everyone", async () => {
      const ec2 = groupWith([tcp(22, 22), tcp(80, 80), tcp(443, 443)]);
      const strategy = new AWSUploadStrategy({ ec2Factory: () => ec2 });
      const step = strategy.plan(awsConfig())[0];
      await expect(step.run({ config: awsConfig(), state: {}, log: () => {} })).resolves.toEqual({
        detail: "ports 80 and 443 are open",
      });
    });

    test("a range or an all-traffic rule counts, an IPv6-only rule too", async () => {
      for (const permissions of [
        [tcp(0, 65535)],
        [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
        [{ IpProtocol: "tcp", FromPort: 80, ToPort: 443, Ipv6Ranges: [{ CidrIpv6: "::/0" }] }],
      ]) {
        const strategy = new AWSUploadStrategy({ ec2Factory: () => groupWith(permissions) });
        const step = strategy.plan(awsConfig())[0];
        await expect(step.run({ config: awsConfig(), state: {}, log: () => {} })).resolves.toBeTruthy();
      }
    });

    test("fails, naming the closed ports, before an instance is created", async () => {
      const ec2 = groupWith([tcp(22, 22), tcp(80, 80), tcp(443, 443, "10.0.0.0/8")]);
      const strategy = new AWSUploadStrategy({ ec2Factory: () => ec2, lookupFn: dnsOf({}) });
      const create = vi.spyOn(strategy, "createInstance");
      const events = [];
      await expect(strategy.deploy(awsConfig(), { onEvent: (e) => events.push(e) })).rejects.toThrow(
        /sg-1 does not allow inbound traffic on port 443 from anywhere/,
      );
      expect(create).not.toHaveBeenCalled();
      expect(events.find((e) => e.id === "firewall" && e.status === "failed")).toBeTruthy();
    });
  });
});
