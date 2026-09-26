import CloudApiStrategy, { keyIdentity } from "./CloudApiStrategy.js";

const FIREWALL_NAME = "gispublisher";
const TAG = "gispublisher";
const EVERYONE = { addresses: ["0.0.0.0/0", "::/0"] };

/**
 * Deploys to a DigitalOcean droplet it creates (or finds by `serverName`). Untested against the
 * real service (it needs an account with a payment method): the unit tests use a fake API.
 */
class DigitalOceanStrategy extends CloudApiStrategy {
  get providerName() {
    return "DigitalOcean";
  }

  get tokenVariable() {
    return "DIGITALOCEAN_TOKEN";
  }

  get apiBase() {
    return "https://api.digitalocean.com/v2";
  }

  errorMessage(data) {
    return data?.message || "";
  }

  async ensureServer(config, log) {
    const name = config.serverName;
    if (!name) throw new Error("A server name is needed (--server-name).");

    const found = await this.api(config, "GET", "/droplets?per_page=200");
    let droplet = (found.droplets || []).find((d) => d.name === name);
    let created = false;

    if (droplet) {
      log(`Droplet ${name} already exists`);
    } else {
      const sshKey = await this.ensureSshKey(config, log);
      await this.ensureFirewall(config, log);
      const response = await this.api(config, "POST", "/droplets", {
        name,
        region: config.serverRegion || "fra1",
        size: config.serverSize || "s-2vcpu-4gb",
        image: config.serverImage || "ubuntu-24-04-x64",
        ssh_keys: [sshKey],
        tags: [TAG],
      });
      droplet = response.droplet;
      created = true;
      log(
        `Droplet ${name} (${droplet.id}) created, waiting for it to start...`,
      );
    }

    const active = await this.waitFor("the droplet starting", async () => {
      const { droplet: current } = await this.api(
        config,
        "GET",
        `/droplets/${droplet.id}`,
      );
      if (current?.status !== "active") return null;
      const ip = (current.networks?.v4 || []).find(
        (n) => n.type === "public",
      )?.ip_address;
      return ip ? { ip } : null;
    });
    log(`Droplet ${name} is active with public IP ${active.ip}`);
    return { ip: active.ip, created };
  }

  /** The fingerprint of the account's ssh key equal to the user's, uploading it when it is new. */
  async ensureSshKey(config, log) {
    const publicKey = this.publicKey(config);
    const { ssh_keys: keys = [] } = await this.api(
      config,
      "GET",
      "/account/keys?per_page=200",
    );
    const same = keys.find(
      (key) => keyIdentity(key.public_key) === keyIdentity(publicKey),
    );
    if (same) return same.fingerprint;
    const { ssh_key: uploaded } = await this.api(
      config,
      "POST",
      "/account/keys",
      {
        name: `gispublisher-${Date.now().toString(36)}`,
        public_key: publicKey,
      },
    );
    log("Your ssh key was added to the DigitalOcean account");
    return uploaded.fingerprint;
  }

  /** A firewall for the droplets tagged `gispublisher`: ssh, http and https (created once). */
  async ensureFirewall(config, log) {
    const { firewalls = [] } = await this.api(
      config,
      "GET",
      "/firewalls?per_page=200",
    );
    if (firewalls.some((f) => f.name === FIREWALL_NAME)) return;
    await this.api(config, "POST", "/firewalls", {
      name: FIREWALL_NAME,
      tags: [TAG],
      inbound_rules: ["22", "80", "443"].map((ports) => ({
        protocol: "tcp",
        ports,
        sources: EVERYONE,
      })),
      outbound_rules: ["tcp", "udp", "icmp"].map((protocol) => ({
        protocol,
        ...(protocol === "icmp" ? {} : { ports: "all" }),
        destinations: EVERYONE,
      })),
    });
    log("Firewall gispublisher created (ports 22, 80 and 443)");
  }
}

export default DigitalOceanStrategy;
