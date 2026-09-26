import RemoteStrategy from "./RemoteStrategy.js";
import {
  EC2Client,
  RunInstancesCommand,
  waitUntilInstanceRunning,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
} from "@aws-sdk/client-ec2";

/** Does a security group permission open `port` (tcp) to the whole internet? */
const opensToEveryone = (permission, port) => {
  const protocolOk =
    permission.IpProtocol === "-1" ||
    (permission.IpProtocol === "tcp" &&
      permission.FromPort <= port &&
      port <= permission.ToPort);
  const everyone =
    (permission.IpRanges || []).some((r) => r.CidrIp === "0.0.0.0/0") ||
    (permission.Ipv6Ranges || []).some((r) => r.CidrIpv6 === "::/0");
  return protocolOk && everyone;
};

/**
 * Creates an EC2 instance (unless `config.host` is given) and deploys to it
 * over ssh, exactly like the generic ssh strategy.
 */
class AWSUploadStrategy extends RemoteStrategy {
  constructor(opts = {}) {
    super(opts);
    this.URL = null;
    this._ec2Factory = opts.ec2Factory || ((options) => new EC2Client(options));
  }

  preSteps(config = {}) {
    return [
      // The HTTPS certificate is issued over ports 80 and 443: find out now, not after
      // the instance is created and the app built, that the security group closes them.
      ...(config.domain
        ? [
            {
              id: "firewall",
              label: "Check the firewall",
              run: (ctx) => this._checkFirewall(ctx),
            },
          ]
        : []),
      {
        id: "instance",
        label: "Create AWS instance",
        run: async (ctx) => {
          if (ctx.config.host) {
            ctx.state.host = ctx.config.host;
            return { skipped: true, detail: `using ${ctx.config.host}` };
          }
          ctx.state.host = await this.createInstance(ctx.config, ctx.log);
          ctx.state.created = true;
        },
      },
    ];
  }

  // A fresh instance needs a while before sshd answers
  connectRetries() {
    return 18;
  }

  resolveUrl(config, state) {
    this.URL = super.resolveUrl(config, state);
    return this.URL;
  }

  getURL() {
    return this.URL;
  }

  /** The EC2 client for this configuration (its own keys, else the SDK's usual lookup). */
  _client(config) {
    const {
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN,
      AWS_REGION,
    } = config;
    // Keys in the config are used as they are. Without them the SDK finds credentials
    // by itself: AWS_* variables, a profile (AWS_PROFILE), SSO, an instance role.
    const credentials =
      AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
            ...(AWS_SESSION_TOKEN ? { sessionToken: AWS_SESSION_TOKEN } : {}),
          }
        : undefined;
    return this._ec2Factory({
      region: AWS_REGION,
      ...(credentials ? { credentials } : {}),
    });
  }

  async _checkFirewall(ctx) {
    const groupId = ctx.config.AWS_SECURITY_GROUP_ID;
    const { SecurityGroups } = await this._client(ctx.config).send(
      new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }),
    );
    const permissions = SecurityGroups?.[0]?.IpPermissions || [];
    const closed = [80, 443].filter(
      (port) => !permissions.some((p) => opensToEveryone(p, port)),
    );
    if (closed.length > 0) {
      throw new Error(
        `The security group ${groupId} does not allow inbound traffic on port ${closed.join(" and ")} from anywhere. ` +
          "The HTTPS certificate needs ports 80 and 443 open: add them to the group in the EC2 console and deploy again.",
      );
    }
    return { detail: "ports 80 and 443 are open" };
  }

  /**
   * Creates an AWS instance and waits for it to run.
   * @param {Object} config
   * @param {(line: String) => void} [log]
   * @returns {Promise<String>} Public IP of the instance
   */
  async createInstance(config, log = console.log) {
    const {
      AWS_INSTANCE_NAME,
      AWS_INSTANCE_TYPE,
      AWS_AMI_ID,
      AWS_KEY_NAME,
      AWS_SECURITY_GROUP_ID,
    } = config;
    const client = this._client(config);

    const { Instances } = await client.send(
      new RunInstancesCommand({
        ImageId: AWS_AMI_ID,
        InstanceType: AWS_INSTANCE_TYPE,
        KeyName: AWS_KEY_NAME,
        MaxCount: 1,
        MinCount: 1,
        SecurityGroupIds: [AWS_SECURITY_GROUP_ID],
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [{ Key: "Name", Value: AWS_INSTANCE_NAME }],
          },
        ],
      }),
    );
    const instanceId = Instances[0].InstanceId;
    log(`Instance ${instanceId} created, waiting for it to start...`);

    await waitUntilInstanceRunning(
      { client, maxWaitTime: 300 },
      { InstanceIds: [instanceId] },
    );

    const { Reservations } = await client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const publicIp = Reservations[0].Instances[0].PublicIpAddress;
    if (!publicIp) {
      throw new Error(
        `Instance ${instanceId} has no public IP (check the subnet settings)`,
      );
    }
    log(`Instance ${instanceId} is running with public IP ${publicIp}`);
    return publicIp;
  }
}

export default AWSUploadStrategy;
