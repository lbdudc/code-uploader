import UploadStrategy from "./UploadStrategy.js";
import { executeCommand } from '../utils/utils.js';
import { EC2Client, RunInstancesCommand, waitUntilInstanceRunning, StartInstancesCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";

class AWSUploadStrategy extends UploadStrategy {

    /**
     * Creates an AWS instance with the specified configuration
     * @param {Object} config Configuration object
     * @returns {Promise<Object>} Object containing the instance ID and public IP of the AWS instance
     */
    async createInstance(config) {

        const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = config;
        const { AWS_INSTANCE_NAME, AWS_INSTANCE_TYPE, AWS_AMI_ID, AWS_KEY_NAME, AWS_SECURITY_GROUP_ID } = config;

        const client = new EC2Client(
            {
                region: AWS_REGION,
                credentials: {
                    accessKeyId: AWS_ACCESS_KEY_ID,
                    secretAccessKey: AWS_SECRET_ACCESS_KEY
                }
            }
        );

        const input = {
            ImageId: AWS_AMI_ID,
            InstanceType: AWS_INSTANCE_TYPE,
            KeyName: AWS_KEY_NAME,
            MaxCount: 1,
            MinCount: 1,
            Monitoring: {
                Enabled: true,
            },
            SecurityGroupIds: [AWS_SECURITY_GROUP_ID],
            TagSpecifications: [
                {
                    ResourceType: "instance",
                    Tags: [
                        {
                            Key: "Name",
                            Value: AWS_INSTANCE_NAME,
                        },
                    ],
                },
            ],
        };

        try {
            const { PublicIpAddress, InstanceId } = await this._startInstance(input, client);

            console.log(`Instance ${InstanceId} is now running with public IP ${PublicIpAddress}`);

            return {
                instanceId: InstanceId,
                publicIp: PublicIpAddress,
            };
        } catch (err) {
            console.error(err);
        }
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
    async configureInstance(config) {

        // Connect to instance and install Docker
        console.log('Connecting to instance and installing Docker...');
        let command = this._getSSHCredentials(config) + '\"sudo yum update -y && sudo yum install -y docker && sudo service docker start\"';
        await executeCommand(command)

        // Install docker-compose
        console.log('Connecting to instance and installing docker-compose...')
        command = this._getSSHCredentials(config) + '\"sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s | tr \'[:upper:]\' \'[:lower:]\')-$(uname -m) -o /usr/bin/docker-compose && sudo chmod 755 /usr/bin/docker-compose && docker-compose --version\"';
        await executeCommand(command)
    }

    /**
     * Runs docker-compose up on the AWS instance
     * @param {String} publicIp Public IP of the AWS instance
     * @param {Object} config Configuration object
     */
    async runDockerComposeUp(config) {

        const { AWS_USERNAME } = config;
        // Run docker-compose up
        console.log('Connecting to instance and running docker-compose up...')
        const command = this._getSSHCredentials(config) + `\"cd /home/${AWS_USERNAME}/code/deploy && sudo docker-compose up -d\"`;
        await executeCommand(command)
    }

    /**
     * Formats the SSH credentials to connect to the AWS instance
     * @param {Object} config 
     * @returns {String} Formatted SSH credentials
     */
    _getSSHCredentials(config) {
        const { publicIp, AWS_SSH_PRIVATE_KEY_PATH, AWS_USERNAME, AWS_REGION } = config;
        //ssh -o StrictHostKeyChecking=no -i .\mykey.pem ec2-user@ec2-13-41-81-214.eu-west-2.compute.amazonaws.com
        const formattedIp = publicIp.replace(/\./g, '-');
        return `ssh -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${AWS_USERNAME}@ec2-${formattedIp}.${AWS_REGION}.compute.amazonaws.com `;
    }

    /**
     * Starts an AWS instance
     * @param {Object} input Input object for the RunInstancesCommand
     * @param {EC2Client} client EC2Client
     * @returns {Promise<Object>} Object containing the instance ID and public IP of the AWS instance
     */
    async _startInstance(input, client) {

        const command = new RunInstancesCommand(input);
        const data = await client.send(command);
        const instanceId = data.Instances[0].InstanceId;

        const startCommand = new StartInstancesCommand({ InstanceIds: [instanceId] });
        await client.send(startCommand);

        console.log(`Waiting for instance ${instanceId} to start up...`);

        // Await for instance to start up
        await waitUntilInstanceRunning(
            { client: client },
            { InstanceIds: [instanceId] }
        );

        console.log(`Instance ${instanceId} is now running`);

        const res = await this._describeInstance(instanceId, client);
        return {
            ...res,
            InstanceId: instanceId,
        }
    }

    /**
     * Describes an AWS instance
     * @param {String} instanceId 
     * @param {EC2Client} client 
     * @returns {Promise<Object>} Object containing the instance ID and public IP of the AWS instance
     */
    async _describeInstance(instanceId, client) {

        const command = new DescribeInstancesCommand({
            InstanceIds: [instanceId],
        })

        const { Reservations } = await client.send(command);
        return Reservations[0].Instances[0];
    }
}

export default AWSUploadStrategy;