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
# Optional
nvm use 

npm install
```

## Pre-requisites

- Have installed in your machine:
  - [Node.js](https://nodejs.org/en/download/)
  - [SSH](https://www.ssh.com/ssh/command/)

- Must be a root user or have sudo privileges in the server where you want to upload the code

## Known Issues :warning:

In AWS instances, the docker-compose up command fails with the basic EC2 free tier instance. This is because the instance does not have enough memory to run the docker-compose up command. To solve this, you can use a bigger instance

## Example Usages

More examples can be found in the `./examples` folder.

### SSH (Debian/Ubuntu)

SSH Usage Example

```js
import { Uploader, DebianUploadStrategy } from 'code-uploader';

const uploader = new Uploader();
uploader.setUploadStrategy(new DebianUploadStrategy());

const config = {
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    certRoute: '/home/certs/id_rsa', // Optional but recommended
    repoPath: 'code/lps/output',
    remoteRepoPath: '/home/username/code',
};

// Upload code, configure the instance and run docker-compose up
await uploader.uploadCode(config);
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

// Upload the code
const uploadRes = await uploader.uploadCode({
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    AWS_AMI_ID,
    AWS_INSTANCE_TYPE,
    AWS_INSTANCE_NAME,
    AWS_SECURITY_GROUP_ID,
    AWS_KEY_NAME,
    AWS_USERNAME,
    AWS_SSH_PRIVATE_KEY_PATH,
    REPO_DIRECTORY,
    REMOTE_REPO_PATH: `/home/${AWS_USERNAME}/code`,
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
