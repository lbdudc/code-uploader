import { describe, test, expect, vi } from "vitest";

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn(),
  RunInstancesCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
  DescribeInstancesCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
  waitUntilInstanceRunning: vi.fn(async () => ({})),
}));

const { default: AWSUploadStrategy } = await import("../../src/strategies/AWSUploadStrategy.js");

const create = async (config) => {
  const seen = [];
  const strategy = new AWSUploadStrategy({
    ec2Factory: (options) => {
      seen.push(options);
      return {
        send: async (command) =>
          command.input.ImageId
            ? { Instances: [{ InstanceId: "i-123" }] }
            : { Reservations: [{ Instances: [{ PublicIpAddress: "198.51.100.9" }] }] },
      };
    },
  });
  const ip = await strategy.createInstance(
    {
      AWS_REGION: "eu-west-1",
      AWS_AMI_ID: "ami-1",
      AWS_INSTANCE_TYPE: "t3.small",
      AWS_INSTANCE_NAME: "demo",
      AWS_KEY_NAME: "key",
      AWS_SECURITY_GROUP_ID: "sg-1",
      ...config,
    },
    () => {},
  );
  return { ip, options: seen[0] };
};

describe("AWS credentials", () => {
  test("keys in the config are handed to the SDK", async () => {
    const { ip, options } = await create({ AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s3cret" }); // pragma: allowlist secret
    expect(ip).toBe("198.51.100.9");
    expect(options).toEqual({
      region: "eu-west-1",
      credentials: { accessKeyId: "AKIA1", secretAccessKey: "s3cret" }, // pragma: allowlist secret
    });
  });

  test("a session token goes along with the keys", async () => {
    const { options } = await create({
      AWS_ACCESS_KEY_ID: "AKIA1",
      AWS_SECRET_ACCESS_KEY: "s3cret", // pragma: allowlist secret
      AWS_SESSION_TOKEN: "tok",
    });
    expect(options.credentials.sessionToken).toBe("tok");
  });

  test("without keys the SDK's own credential chain (profile, SSO, environment) is used", async () => {
    const { options } = await create({});
    expect(options).toEqual({ region: "eu-west-1" });
    expect("credentials" in options).toBe(false);
  });

  test("half a key pair is not passed on", async () => {
    const { options } = await create({ AWS_ACCESS_KEY_ID: "AKIA1" });
    expect("credentials" in options).toBe(false);
  });
});
