import RemoteStrategy from "./RemoteStrategy.js";
import {
  EC2Client,
  RunInstancesCommand,
  waitUntilInstanceRunning,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";

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

  preSteps() {
    return [
      {
        id: "instance",
        label: "Create AWS instance",
        run: async (ctx) => {
          if (ctx.config.host) {
            ctx.state.host = ctx.config.host;
            return { skipped: true, detail: `using ${ctx.config.host}` };
          }
          ctx.state.host = await this.createInstance(ctx.config, ctx.log);
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

  /**
   * Creates an AWS instance and waits for it to run.
   * @param {Object} config
   * @param {(line: String) => void} [log]
   * @returns {Promise<String>} Public IP of the instance
   */
  async createInstance(config, log = console.log) {
    const {
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      AWS_REGION,
      AWS_INSTANCE_NAME,
      AWS_INSTANCE_TYPE,
      AWS_AMI_ID,
      AWS_KEY_NAME,
      AWS_SECURITY_GROUP_ID,
    } = config;

    const client = this._ec2Factory({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });

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
