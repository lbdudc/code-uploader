# Code Uploader

![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2012.0.0-brightgreen.svg)
![npm version](https://badge.fury.io/js/code-uploader.svg)

## Description

The **Code Uploader** is a versatile library designed to simplify the process of uploading code to a server and executing it via docker-compose. This library provides flexible strategies to facilitate code deployment across different environments, such as SSH-based servers, AWS instances, and local setups.

## Installation

Install the package via npm:

```bash
npm install @lbdudc/gp-code-uploader
```

## Pre-requisites

- Have installed in your machine:
  - [Node.js](https://nodejs.org/en/download/)
  - [SSH](https://www.ssh.com/ssh/command/)

- Must be a root user or have sudo privileges in the server where you want to upload the code

## Known Issues :warning:

In AWS instances, the docker-compose up command can fail with the basic EC2 free tier instance. This is because the instance does not have enough memory to run the docker-compose up command. To solve this, you can use a bigger instance

## Example Usages

More examples can be found in the `./examples` folder.

### SSH (Debian/Ubuntu)

SSH Usage Example

```js
import { Uploader, DebianUploadStrategy } from '@lbdudc/gp-code-uploader';

const uploader = new Uploader();
uploader.setUploadStrategy(new DebianUploadStrategy());

const config = {
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    certRoute: '/home/certs/id_rsa', // Optional but recommended
    repoPath: 'code/lps/output',
    remoteRepoPath: '/home/username/code',
    forceBuild: true, // default false
};

// Upload code, configure the instance and run docker-compose up
await uploader.uploadCode(config);
```

### AWS

<details>
<summary>AWS Usage Example</summary>

```js
import { Uploader, AWSUploadStrategy } from '@lbdudc/gp-code-uploader';

// Create the uploader
const uploader = new Uploader();

// Set the upload strategy
uploader.setUploadStrategy(new AWSUploadStrategy());

// Create AWS instance
const hostIp = await uploader.createInstance({
    AWS_SECRET_ACCESS_KEY: '',
    AWS_REGION: 'eu-west-2',
    AWS_AMI_ID: 'ami-08b064b1296caf3b2',
    AWS_INSTANCE_TYPE: 't2.micro',
    AWS_INSTANCE_NAME: 'my-aws-instance',
    AWS_SECURITY_GROUP_ID: 'sg-xxxxxxxxxxxxxxxxx',
    AWS_KEY_NAME: 'my-key-pair',
    AWS_USERNAME: 'ec2-user',
    AWS_SSH_PRIVATE_KEY_PATH:'./my-key-pair.pem',
    AWS_ACCESS_KEY_ID: '',
});

// Upload code by SCP, configure instance, and run docker-compose up
await uploader.uploadCode({
    host: hostIp,
    username: 'ec2-user',
    certRoute: './my-key-pair.pem',
    awsRegion: 'eu-west-2',
    repoPath: '../code',
    remoteRepoPath: `/home/ec2-user/code`,
    // forceBuild: true,
});
```

</details>

## Methods

`uploader.js` exposes the following methods:

- `uploadCode(options): Promise<UploadCodeResponse>`: Uploads the code, configures the instance and runs docker-compose up

## AWS Instance Pre-requisites

You need to create an AWS instance with the following:

- An SSH key pair [guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-key-pairs.html)
- A security group with the following inbound rules: [guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html?icmpid=docs_ec2_console#creating-security-group)
  - SSH (port 22) from your IP (or the IP of the server you want to access the instance from)
  - HTTP (port 80) from your IP (or the IP of the server you want to access the instance from)
- A security group with the following outboud rules: [guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html?icmpid=docs_ec2_console#creating-security-group)
  - All traffic (all ports) to your IP (or the IP of the server you want to access the instance from)
- An IAM role with the following permissions: [guide](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html?icmpid=docs_console_unmapped)
  - AmazonEC2FullAccess
- Get your AWS access key and secret key: [guide](https://docs.aws.amazon.com/general/latest/gr/aws-sec-cred-types.html#access-keys-and-secret-access-keys)

## Dependencies

- **@aws-sdk/client-ec2**: ^3.32.0
- **dotenv**: ^16.0.3
- **jszip**: ^3.10.1

## Dev Dependencies

- **@vitest/coverage-istanbul**: ^0.32.2
- **vitest**: ^0.32.0

## Author

Victor Lamas
Email: <victor.lamas@udc.es>

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
