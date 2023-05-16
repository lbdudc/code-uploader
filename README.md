# Code uploader

This is a library to upload code to a server and execute it.

## Installation

In the `package.json` file, add the following:

```json
"dependencies": {
    "code-uploader": "git+https://gitlab.lbd.org.es/GEMA/lps/code-uploader.git"
}
```

Execute the following command:

```bash
npm install
```

## Example Usages

More examples can be found in the `./examples` folder.

### SSH

SSH Usage Example

```js
import { Uploader, SSHUploadStrategy } from 'code-uploader';

// Create the uploader
const uploader = new Uploader();

// Set the upload strategy
uploader.setUploadStrategy(new SSHUploadStrategy());

// Upload the code
const uploadRes = await uploader.uploadCode({
    host: '',
    username: '',
    password: '',
    repoDirectory: '',
    remoteRepoPath: '',
});

// Example of executing a command on the server
await uploader.executeCommand(`ssh -o StrictHostKeyChecking=no ${username}@${host} "sudo ls -la /home/${username}/code"`);
```

### AWS

<details>
<summary>AWS Usage Example</summary>

```js
import { Uploader, AWSUploadStrategy } from 'code-uploader';

// Create the uploader
const uploader = new Uploader();

// Set the upload strategy
uploader.setUploadStrategy(new AWSUploadStrategy());

// Create the instance (needed for the AWS strategy)
const res = await uploader.createInstance({
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    AWS_AMI_ID,
    AWS_INSTANCE_TYPE,
    AWS_INSTANCE_NAME,
    AWS_SECURITY_GROUP_ID,
    AWS_KEY_NAME,
});

// Upload the code
const uploadRes = await uploader.uploadCode({
    publicIp: res.publicIp,
    AWS_USERNAME,
    AWS_SSH_PRIVATE_KEY_PATH,
    REPO_DIRECTORY,
    REMOTE_REPO_PATH: `/home/${AWS_USERNAME}/code`,
});

// Configure AWS instance installing docker, nginx, docker-compose and running the docker-compose file
await uploader.configureInstance({
    publicIp: res.publicIp,
    AWS_USERNAME: process.env.AWS_USERNAME || 'ec2-user',
    AWS_SSH_PRIVATE_KEY_PATH: process.env.AWS_SSH_PRIVATE_KEY_PATH || './my-key-pair.pem',
})

// Example of executing a command on the AWS instance
await uploader.executeCommand(`ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@${publicIp} "sudo ls -la /home/${AWS_USERNAME}/code"`);
```

</details>

## Methods

`uploader.js` exposes the following methods:

- `setUploadStrategy(strategy: UploadStrategy): void`: Sets the upload strategy to use
- `createInstance(options): Promise<CreateInstanceResponse>`: Creates an instance (needed for the AWS strategy)
- `uploadCode(options): Promise<UploadCodeResponse>`: Uploads the code to the instance
- `executeCommand(command: string): Promise<ExecuteCommandResponse>` Executes a command in the shell

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
