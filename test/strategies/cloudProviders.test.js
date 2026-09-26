import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import HetznerStrategy from "../../src/strategies/HetznerStrategy.js";
import DigitalOceanStrategy from "../../src/strategies/DigitalOceanStrategy.js";

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-strategy-"));
  fs.mkdirSync(path.join(repo, "deploy"));
  fs.writeFileSync(path.join(repo, "deploy", "docker-compose.yml"), "services: {}");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const READY_ROW = JSON.stringify({ Service: "web", Name: "w", State: "running", Health: "healthy", ExitCode: 0 });
const PUB = "ssh-ed25519 AAAAC3Nza me@laptop";

const fakeSsh = () => ({
  exec: vi.fn(async (script) => {
    if (script.includes("echo READY")) return { stdout: "READY" };
    if (script.includes("&& echo YES")) return { stdout: "NO" };
    if (script.includes("'ps'")) return { stdout: READY_ROW };
    return { stdout: "" };
  }),
  upload: vi.fn(async () => {}),
});

/** A fake REST API: `routes` maps "METHOD /path" to a body (or a function of the request body). */
const fakeApi = (routes) => {
  const calls = [];
  const fetchFn = vi.fn(async (url, init) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method} ${pathname}${search}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: init.headers });
    const route = routes[key];
    if (route === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ message: `no route ${key}` }) };
    const value = typeof route === "function" ? route(body) : route;
    if (value?.status) return { ok: false, status: value.status, text: async () => JSON.stringify(value.body || {}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  });
  return { fetchFn, calls };
};

const config = (extra = {}) => ({
  type: "hetzner",
  cloudToken: "tok",
  serverName: "gis-app",
  certRoute: "/keys/id_ed25519",
  repoPath: repo,
  ...extra,
});

const options = (api, ssh) => ({
  fetchFn: api.fetchFn,
  readFileFn: () => `${PUB}\n`,
  sshFactory: () => ssh,
  sleepFn: async () => {},
  pollMs: 0,
});

describe("HetznerStrategy", () => {
  const routes = (over = {}) => ({
    "GET /v1/servers?name=gis-app": { servers: [] },
    "GET /v1/ssh_keys": { ssh_keys: [] },
    "POST /v1/ssh_keys": { ssh_key: { id: 11 } },
    "GET /v1/firewalls?name=gispublisher": { firewalls: [] },
    "POST /v1/firewalls": { firewall: { id: 22 } },
    "POST /v1/servers": { server: { id: 33, status: "initializing" } },
    "GET /v1/servers/33": { server: { id: 33, status: "running", public_net: { ipv4: { ip: "203.0.113.9" } } } },
    ...over,
  });

  test("creates the key, the firewall and the server, then deploys over ssh as root", async () => {
    const api = fakeApi(routes());
    const ssh = fakeSsh();
    const seen = [];
    const strategy = new HetznerStrategy({ ...options(api, ssh), sshFactory: (o) => (seen.push(o), ssh) });
    const events = [];
    const result = await strategy.deploy(config(), { onEvent: (e) => events.push(e) });

    const create = api.calls.find((c) => c.key === "POST /v1/servers").body;
    expect(create).toMatchObject({
      name: "gis-app",
      server_type: "cx22",
      image: "ubuntu-24.04",
      location: "fsn1",
      ssh_keys: [11],
      firewalls: [{ firewall: 22 }],
    });
    const rules = api.calls.find((c) => c.key === "POST /v1/firewalls").body.rules;
    expect(rules.map((r) => r.port)).toEqual(["22", "80", "443"]);
    expect(api.calls[0].headers.Authorization).toBe("Bearer tok");
    expect(seen[0]).toMatchObject({ host: "203.0.113.9", username: "root", identityFile: "/keys/id_ed25519" });
    expect(ssh.upload.mock.calls[0][1]).toBe("/root/gispublisher-app");
    expect(result.url).toBe("http://203.0.113.9");
    expect(events.find((e) => e.id === "instance" && e.status === "done")).toBeTruthy();
  });

  test("reuses the ssh key, the firewall and a server that already exist", async () => {
    const api = fakeApi(
      routes({
        "GET /v1/servers?name=gis-app": {
          servers: [{ id: 33, status: "running", public_net: { ipv4: { ip: "203.0.113.9" } } }],
        },
      }),
    );
    const strategy = new HetznerStrategy(options(api, fakeSsh()));
    const result = await strategy.deploy(config(), { onEvent: () => {} });
    expect(result.url).toBe("http://203.0.113.9");
    expect(api.calls.some((c) => c.key.startsWith("POST"))).toBe(false);
  });

  test("an existing account key equal to the user's is not uploaded again", async () => {
    const api = fakeApi(routes({ "GET /v1/ssh_keys": { ssh_keys: [{ id: 5, public_key: `${PUB} other-comment` }] } }));
    await new HetznerStrategy(options(api, fakeSsh())).deploy(config(), { onEvent: () => {} });
    expect(api.calls.some((c) => c.key === "POST /v1/ssh_keys")).toBe(false);
    expect(api.calls.find((c) => c.key === "POST /v1/servers").body.ssh_keys).toEqual([5]);
  });

  test("size, location and image come from the configuration", async () => {
    const api = fakeApi(routes());
    await new HetznerStrategy(options(api, fakeSsh())).deploy(
      config({ serverSize: "cx42", serverRegion: "hel1", serverImage: "debian-12" }),
      { onEvent: () => {} },
    );
    expect(api.calls.find((c) => c.key === "POST /v1/servers").body).toMatchObject({
      server_type: "cx42",
      location: "hel1",
      image: "debian-12",
    });
  });

  test("a refused token is explained", async () => {
    const api = fakeApi(routes({ "GET /v1/servers?name=gis-app": { status: 401 } }));
    await expect(
      new HetznerStrategy(options(api, fakeSsh())).deploy(config(), { onEvent: () => {} }),
    ).rejects.toThrow(/refused the API token/);
  });

  test("a missing token and a missing public key are explained", async () => {
    const api = fakeApi(routes());
    await expect(
      new HetznerStrategy(options(api, fakeSsh())).deploy(config({ cloudToken: "" }), { onEvent: () => {} }),
    ).rejects.toThrow(/HCLOUD_TOKEN/);
    const noKey = new HetznerStrategy({
      ...options(api, fakeSsh()),
      readFileFn: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(noKey.deploy(config(), { onEvent: () => {} })).rejects.toThrow(/public ssh key/);
  });

  test("an API error carries the provider's message", async () => {
    const api = fakeApi(routes({ "POST /v1/servers": { status: 422, body: { error: { message: "server type not found" } } } }));
    await expect(
      new HetznerStrategy(options(api, fakeSsh())).deploy(config(), { onEvent: () => {} }),
    ).rejects.toThrow(/server type not found/);
  });

  test("a host in the configuration skips the server creation", async () => {
    const api = fakeApi({});
    const strategy = new HetznerStrategy(options(api, fakeSsh()));
    const events = [];
    await strategy.deploy(config({ host: "198.51.100.4" }), { onEvent: (e) => events.push(e) });
    expect(api.fetchFn).not.toHaveBeenCalled();
    expect(events.find((e) => e.id === "instance" && e.status === "skipped")).toBeTruthy();
  });

  test("has the server step first and retries the first connection", () => {
    const strategy = new HetznerStrategy();
    expect(strategy.plan({})[0].id).toBe("instance");
    expect(strategy.connectRetries()).toBeGreaterThan(0);
  });
});

describe("DigitalOceanStrategy", () => {
  const droplet = (over = {}) => ({
    id: 44,
    name: "gis-app",
    status: "active",
    networks: { v4: [{ type: "private", ip_address: "10.0.0.2" }, { type: "public", ip_address: "192.0.2.50" }] },
    ...over,
  });
  const routes = (over = {}) => ({
    "GET /v2/droplets?per_page=200": { droplets: [] },
    "GET /v2/account/keys?per_page=200": { ssh_keys: [] },
    "POST /v2/account/keys": { ssh_key: { id: 1, fingerprint: "aa:bb" } },
    "GET /v2/firewalls?per_page=200": { firewalls: [] },
    "POST /v2/firewalls": { firewall: { id: "f" } },
    "POST /v2/droplets": { droplet: droplet({ status: "new", networks: {} }) },
    "GET /v2/droplets/44": { droplet: droplet() },
    ...over,
  });
  const doConfig = (extra = {}) => config({ type: "digitalocean", ...extra });

  test("creates the key, the tag firewall and the droplet, then deploys over ssh as root", async () => {
    const api = fakeApi(routes());
    const seen = [];
    const ssh = fakeSsh();
    const strategy = new DigitalOceanStrategy({ ...options(api, ssh), sshFactory: (o) => (seen.push(o), ssh) });
    const result = await strategy.deploy(doConfig(), { onEvent: () => {} });

    expect(api.calls.find((c) => c.key === "POST /v2/droplets").body).toMatchObject({
      name: "gis-app",
      region: "fra1",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      ssh_keys: ["aa:bb"],
      tags: ["gispublisher"],
    });
    const firewall = api.calls.find((c) => c.key === "POST /v2/firewalls").body;
    expect(firewall.tags).toEqual(["gispublisher"]);
    expect(firewall.inbound_rules.map((r) => r.ports)).toEqual(["22", "80", "443"]);
    expect(seen[0]).toMatchObject({ host: "192.0.2.50", username: "root" });
    expect(result.url).toBe("http://192.0.2.50");
  });

  test("reuses an existing droplet, key and firewall", async () => {
    const api = fakeApi(
      routes({ "GET /v2/droplets?per_page=200": { droplets: [droplet()] } }),
    );
    const result = await new DigitalOceanStrategy(options(api, fakeSsh())).deploy(doConfig(), { onEvent: () => {} });
    expect(result.url).toBe("http://192.0.2.50");
    expect(api.calls.some((c) => c.key.startsWith("POST"))).toBe(false);
  });

  test("an existing firewall named gispublisher is not created twice", async () => {
    const api = fakeApi(routes({ "GET /v2/firewalls?per_page=200": { firewalls: [{ name: "gispublisher" }] } }));
    await new DigitalOceanStrategy(options(api, fakeSsh())).deploy(doConfig(), { onEvent: () => {} });
    expect(api.calls.some((c) => c.key === "POST /v2/firewalls")).toBe(false);
  });

  test("a refused token and an API error are explained", async () => {
    const denied = fakeApi(routes({ "GET /v2/droplets?per_page=200": { status: 401 } }));
    await expect(
      new DigitalOceanStrategy(options(denied, fakeSsh())).deploy(doConfig(), { onEvent: () => {} }),
    ).rejects.toThrow(/DigitalOcean refused the API token/);
    const bad = fakeApi(routes({ "POST /v2/droplets": { status: 422, body: { message: "size is not available" } } }));
    await expect(
      new DigitalOceanStrategy(options(bad, fakeSsh())).deploy(doConfig(), { onEvent: () => {} }),
    ).rejects.toThrow(/size is not available/);
  });

  test("a domain on a machine created now only warns", async () => {
    const api = fakeApi(routes());
    const events = [];
    const strategy = new DigitalOceanStrategy({ ...options(api, fakeSsh()), lookupFn: async (n) => (n === "gis.example.org" ? ["1.1.1.1"] : ["192.0.2.50"]) });
    const result = await strategy.deploy(doConfig({ domain: "gis.example.org" }), { onEvent: (e) => events.push(e) });
    expect(result.url).toBe("https://gis.example.org");
    expect(events.find((e) => e.id === "domain" && e.status === "done")).toBeTruthy();
  });
});
