import { Uploader, AWSUploadStrategy } from '../index.js';
import dotenv from 'dotenv';

// Load .env file
dotenv.config();

const uploader = new Uploader();
uploader.setUploadStrategy(new AWSUploadStrategy());

// Create AWS instance
const res = await uploader.createInstance({
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
    AWS_REGION: process.env.AWS_REGION || 'eu-west-2',

    AWS_AMI_ID: process.env.AWS_AMI_ID || 'ami-08b064b1296caf3b2',
    AWS_INSTANCE_TYPE: process.env.AWS_INSTANCE_TYPE || 't2.micro',
    AWS_INSTANCE_NAME: process.env.AWS_INSTANCE_NAME || 'my-aws-instance',
    AWS_SECURITY_GROUP_ID: process.env.AWS_SECURITY_GROUP_ID || 'sg-xxxxxxxxxxxxxxxxx',
    AWS_KEY_NAME: process.env.AWS_KEY_NAME || 'my-key-pair',
});

// Upload code to AWS instance
await uploader.uploadCode({
    publicIp: res.publicIp,
    AWS_USERNAME: process.env.AWS_USERNAME || 'ec2-user',
    AWS_SSH_PRIVATE_KEY_PATH: process.env.AWS_SSH_PRIVATE_KEY_PATH || './my-key-pair.pem',
    REPO_DIRECTORY: process.env.REPO_DIRECTORY || '../code',
    REMOTE_REPO_PATH: `/home/${process.env.AWS_USERNAME || 'ec2-user'}/code`,
});

// Configure AWS instance installing docker, nginx, docker-compose and running the docker-compose file
await uploader.configureInstance({
    publicIp: res.publicIp,
    AWS_USERNAME: process.env.AWS_USERNAME || 'ec2-user',
    AWS_SSH_PRIVATE_KEY_PATH: process.env.AWS_SSH_PRIVATE_KEY_PATH || './my-key-pair.pem',
})

// Example of executing a command on the AWS instance
await uploader.executeCommand(`ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@${publicIp} "sudo ls -la /home/${AWS_USERNAME}/code"`);