import UploadStrategy from "./UploadStrategy.js";
import { executeCommand } from '../utils/utils.js';
import pkg from 'aws-sdk';
const { EC2 } = pkg;

class AWSUploadStrategy extends UploadStrategy {


    /**
     * Creates an AWS instance with the specified configuration
     * @param {Object} config Configuration object
     * @returns {Promise<Object>} Object containing the instance ID and public IP of the AWS instance
     */
    async createInstance(config) {

        const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = config;
        const { AWS_INSTANCE_NAME, AWS_INSTANCE_TYPE, AWS_AMI_ID, AWS_KEY_NAME, AWS_SECURITY_GROUP_ID } = config;

        const ec2 = new EC2({
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
            region: AWS_REGION,
        });

        const instanceParams = {
            ImageId: AWS_AMI_ID,
            InstanceType: AWS_INSTANCE_TYPE,
            KeyName: AWS_KEY_NAME,
            SecurityGroupIds: [AWS_SECURITY_GROUP_ID],
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [{
                ResourceType: 'instance',
                Tags: [{
                    Key: 'Name',
                    Value: AWS_INSTANCE_NAME,
                }],
            }],
        };

        return new Promise((resolve, reject) => {
            ec2.runInstances(instanceParams, (err, data) => {
                if (err) {
                    console.error(err);
                    reject(err);
                }

                const instanceId = data.Instances[0].InstanceId;
                console.log(`Waiting for instance ${instanceId} to start up...`);

                ec2.waitFor('instanceRunning', { InstanceIds: [instanceId] }, async (err, data) => {
                    if (err) {
                        console.error(err);
                        reject(err);
                    }

                    const publicIp = data.Reservations[0].Instances[0].PublicIpAddress;
                    console.log(`Instance ${instanceId} is now running with public IP ${publicIp}`);

                    resolve({
                        instanceId,
                        publicIp,
                    });
                });
            });
        });
    }

    /**
     * Uploads folder containing code files into an AWS instance
     * @param {String} publicIp Public IP of the AWS instance
     * @param {Object} config Configuration object
     * 
     * @returns {Promise<void>} 
     */
    async uploadCode({ publicIp, ...config }) {

        const { AWS_SSH_PRIVATE_KEY_PATH, REPO_DIRECTORY, REMOTE_REPO_PATH, AWS_USERNAME } = config;

        console.log('Copying repository to instance...');
        let command = `scp -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} -r ${REPO_DIRECTORY} ${AWS_USERNAME}@${publicIp}:${REMOTE_REPO_PATH}`;
        await executeCommand(command)
    }

    /**
     * Configures the AWS instance by installing Docker, nginx, and docker-compose
     * @param {String} publicIp Public IP of the AWS instance 
     * @param {Object} config Configuration object
     * 
     * @returns {Promise<void>}
     */
    async configureInstance({ publicIp, ...config }) {

        const { AWS_SSH_PRIVATE_KEY_PATH, AWS_USERNAME } = config;

        // Connect to instance and install Docker
        console.log('Connecting to instance and installing Docker...');
        command = `ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@${publicIp} "sudo yum update -y && sudo yum install -y docker && sudo service docker start"`;
        await executeCommand(command)

        // Install and run nginx
        console.log('Connecting to instance and installing nginx...')
        command = `ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@${publicIp} "sudo amazon-linux-extras enable nginx1 && sudo yum -y install nginx && sudo service nginx start"`
        await executeCommand(command)

        // Copy configuration files to nginx
        console.log('Connecting to instance and copying nginx configuration files (overriding it)...')
        command = `ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@${publicIp} "sudo cp /home/${AWS_USERNAME}/code/nginx.conf /etc/nginx/nginx.conf && sudo service nginx restart"`
        await executeCommand(command)

        // Install docker-compose
        console.log('Connecting to instance and installing docker-compose...')
        command = `ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@${publicIp} "sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s | tr \'[:upper:]\' \'[:lower:]\')-$(uname -m) -o /usr/bin/docker-compose && sudo chmod 755 /usr/bin/docker-compose && docker-compose --version"`
        await executeCommand(command)
    }
}

export default AWSUploadStrategy;