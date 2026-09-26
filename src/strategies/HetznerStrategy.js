import CloudApiStrategy, { keyIdentity } from "./CloudApiStrategy.js";

const FIREWALL_NAME = "gispublisher";
const EVERYONE = ["0.0.0.0/0", "::/0"];

/**
 * Deploys to a Hetzner Cloud server it creates (or finds by `serverName`). Untested against the
 * real service (it needs an account with a payment method): the unit tests use a fake API.
 */
class HetznerStrategy extends CloudApiStrategy {
  get providerName() {
    return "Hetzner Cloud";
  }

  get tokenVariable() {
    return "HCLOUD_TOKEN";
  }

  get apiBase() {
    return "https://api.hetzner.cloud/v1";
  }

  errorMessage(data) {
    return data?.error?.message || "";
  }

  async ensureServer(config, log) {
    const name = config.serverName;
    if (!name) throw new Error("A server name is needed (--server-name).");

    const found = await this.api(
      config,
      "GET",
      `/servers?name=${encodeURIComponent(name)}`,
    );
    let server = found.servers?.[0];
    let created = false;

    if (server) {
      log(
        `Server ${name} already exists (${server.public_net?.ipv4?.ip || server.status})`,
      );
    } else {
      const sshKey = await this.ensureSshKey(config, log);
      const firewall = await this.ensureFirewall(config, log);
      const response = await this.api(config, "POST", "/servers", {
        name,
        server_type: config.serverSize || "cx22",
        image: config.serverImage || "ubuntu-24.04",
        location: config.serverRegion || "fsn1",
        ssh_keys: [sshKey],
        firewalls: [{ firewall }],
        start_after_create: true,
        labels: { "managed-by": "gispublisher" },
      });
      server = response.server;
      created = true;
      log(`Server ${name} (${server.id}) created, waiting for it to start...`);
    }

    const running = await this.waitFor("the server starting", async () => {
      const { server: current } = await this.api(
        config,
        "GET",
        `/servers/${server.id}`,
      );
      return current?.status === "running" && current.public_net?.ipv4?.ip
        ? current
        : null;
    });
    const ip = running.public_net.ipv4.ip;
    log(`Server ${name} is running with public IP ${ip}`);
    return { ip, created };
  }

  /** The id of the account's ssh key equal to the user's, uploading it when it is new. */
  async ensureSshKey(config, log) {
    const publicKey = this.publicKey(config);
    const { ssh_keys: keys = [] } = await this.api(config, "GET", "/ssh_keys");
    const same = keys.find(
      (key) => keyIdentity(key.public_key) === keyIdentity(publicKey),
    );
    if (same) return same.id;
    const { ssh_key: uploaded } = await this.api(config, "POST", "/ssh_keys", {
      name: `gispublisher-${Date.now().toString(36)}`,
      public_key: publicKey,
    });
    log("Your ssh key was added to the Hetzner project");
    return uploaded.id;
  }

  /** The id of the firewall that opens ssh, http and https (created once, reused after). */
  async ensureFirewall(config, log) {
    const { firewalls = [] } = await this.api(
      config,
      "GET",
      `/firewalls?name=${FIREWALL_NAME}`,
    );
    if (firewalls[0]) return firewalls[0].id;
    const { firewall } = await this.api(config, "POST", "/firewalls", {
      name: FIREWALL_NAME,
      rules: ["22", "80", "443"].map((port) => ({
        direction: "in",
        protocol: "tcp",
        port,
        source_ips: EVERYONE,
      })),
    });
    log("Firewall gispublisher created (ports 22, 80 and 443)");
    return firewall.id;
  }
}

export default HetznerStrategy;
