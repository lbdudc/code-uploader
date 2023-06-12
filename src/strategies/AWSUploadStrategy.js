import UploadStrategy from "./UploadStrategy.js";
import { executeCommand, getAbsolutePath } from '../utils/utils.js';
import { compressFolder } from '../utils/zipUtils.js';
import { EC2Client, RunInstancesCommand, waitUntilInstanceRunning, StartInstancesCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import fs, { rm } from 'fs';
import os from 'os';

class AWSUploadStrategy extends UploadStrategy {

    /**
    * Uploads the code to the remote machine, sets up the machine, and runs docker-compose up
    * @param {Object} config Configuration object
    */
    async uploadCode(config) {

        config.REPO_DIRECTORY = config.REPO_DIRECTORY || config.repoPath;

        console.log('STEP 1/5 - Preparing code for upload...');
        await this._prepareCode(config);

        // STEP 1 - CREATE INSTANCE
        console.log('STEP 2/5 - Creating instance...');
        const { publicIp } = await this._createInstance(config);

        // STEP 2 - SEND CODE
        console.log('STEP 3/5 - Sending code...');
        await this._sendCode({ ...config, publicIp });

        // STEP 3 - CONFIGURE INSTANCE
        console.log('STEP 4/5 - Configuring instance...');
        await this._configureInstance({ ...config, publicIp });

        // STEP 4 - RUN DOCKER-COMPOSE UP
        console.log('STEP 5/5 - Running docker-compose up...');
        await this._runDockerComposeUp({ ...config, publicIp });
    }

    async _prepareCode(config) {
        const { forceBuild } = config;

        // If forceBuild is true, build the client
        if (!!forceBuild) {
            // Build the client
            await this._buildClient(config);
        }
    }

    async _buildClient(config) {
        const { REPO_DIRECTORY } = config;

        // Check if the client has node_modules folder
        const absPath = await getAbsolutePath(REPO_DIRECTORY);
        const clientPath = absPath + '/client';

        const nodeModulesPath = clientPath + '/node_modules';

        console.log(nodeModulesPath);

        // Get the node version from .nvmrc file
        const nodeVersion = fs.readFileSync(clientPath + '/.nvmrc', 'utf8').trim();

        // If it doesn't have node_modules folder, install the dependencies
        if (!fs.existsSync(nodeModulesPath)) {
            console.log('---- Installing dependencies...');
            const command = `cd ${clientPath} && npm_config_node_version=${nodeVersion} npm install`;
            try {
                await executeCommand(command);
            } catch (error) {
                console.error(error);
                return;
            }
        } else {
            console.log('---- Dependencies already installed!');
        }

        // Build the client
        console.log('---- Building client...');
        const command = `cd ${clientPath} && npm_config_node_version=${nodeVersion} npm run build`;
        try {
            await executeCommand(command);
        } catch (error) {
            console.error(error);
            return;
        }

        // Remove the node_modules folder
        console.log('---- Removing node_modules folder...');
        rm(nodeModulesPath, { recursive: true }, () => { });


        // Delete the client service from docker-compose.yml
        console.log('---- Comment client service from docker-compose.yml...');
        const dockerComposePath = absPath + '/deploy/docker-compose.yml';
        const dockerCompose = fs.readFileSync(dockerComposePath, 'utf8');
        try {
            // Comment all lines of the client service
            const clientService = dockerCompose.match(/client:\n\s+build:\n\s+context:.*\n\s+dockerfile:.*\n\s+container_name:.*\n\s+networks:\n\s+- local\n\s+volumes:\n\s+-.*\n/g)[0];
            const newDockerCompose = dockerCompose.replace(clientService, clientService.split('\n').map(line => `# ${line}`).join('\n'));
            fs.writeFileSync(dockerComposePath, newDockerCompose, 'utf8');
        } catch (error) {
            console.log('---- Docker-compose not modified!');
            return;
        }

    }

    /**
     * Creates an AWS instance with the specified configuration
     * @param {Object} config Configuration object
     * @returns {Promise<Object>} Object containing the instance ID and public IP of the AWS instance
     */
    async _createInstance(config) {

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

    async _sendCode({ publicIp, ...config }) {
        const { AWS_SSH_PRIVATE_KEY_PATH, REPO_DIRECTORY, REMOTE_REPO_PATH, AWS_USERNAME } = config;

        const outterQuot = os.type().toLowerCase().includes('windows') ? '"' : "'";

        // Zip the code
        console.log('----- Zipping code...');
        const absPath = await getAbsolutePath(REPO_DIRECTORY);
        const zipPath = absPath + '.zip';
        const zipName = absPath.split(/\/|\\/).pop() + '.zip';

        await compressFolder(absPath, `${zipPath}`);

        // Check if the folder exists, if not, create it
        console.log('----- Checking if remote folder exists...');
        let command = this._getSSHCredentials({ publicIp, ...config }) + ` ${outterQuot} if [ ! -d ${REMOTE_REPO_PATH} ]; then mkdir ${REMOTE_REPO_PATH}; fi ${outterQuot}`;
        await executeCommand(command);

        // Upload the code to the AWS instance
        console.log('----- Copying repository to instance...');
        command = `scp -o StrictHostKeyChecking=no -i ${AWS_SSH_PRIVATE_KEY_PATH} ${zipPath} ${AWS_USERNAME}@${publicIp}:${REMOTE_REPO_PATH}`;
        await executeCommand(command)

        // Unzip the code
        console.log('----- Unzipping code...');
        // check if unzip is installed, if not, install it
        command = this._getSSHCredentials({ publicIp, ...config }) + ` ${outterQuot} if ! command -v unzip &> /dev/null; then sudo yum install unzip -y; fi ${outterQuot}`;
        await executeCommand(command);

        command = this._getSSHCredentials({ publicIp, ...config }) + ` ${outterQuot} unzip -o ${REMOTE_REPO_PATH}/${zipName} -d ${REMOTE_REPO_PATH} ${outterQuot}`;
        await executeCommand(command);

        // Remove the zip files from the AWS instance and local machine
        console.log('----- Removing zip files...');
        command = this._getSSHCredentials({ publicIp, ...config }) + ` ${outterQuot} rm ${REMOTE_REPO_PATH}/${zipName} ${outterQuot}`;
        await executeCommand(command);
        rm(zipPath, () => { });
    }

    /**
     * Configures the AWS instance by installing Docker, nginx, and docker-compose
     * @param {String} publicIp Public IP of the AWS instance 
     * @param {Object} config Configuration object
     * 
     * @returns {Promise<void>}
     */
    async _configureInstance(config) {

        const outterQuot = os.type().toLowerCase().includes('windows') ? '"' : "'";

        let command = '';

        // Connect to instance and install Docker
        console.log('Connecting to instance and installing Docker...');
        command = this._getSSHCredentials(config) + ` ${outterQuot} sudo yum update -y && sudo yum install -y docker && sudo service docker start ${outterQuot}`;
        await executeCommand(command)

        // Install docker-compose
        console.log('Connecting to instance and installing docker-compose...')
        command = this._getSSHCredentials(config) + ` ${outterQuot} sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s | tr \'[:upper:]\' \'[:lower:]\')-$(uname -m) -o /usr/bin/docker-compose && sudo chmod 755 /usr/bin/docker-compose && docker-compose --version ${outterQuot}`;
        await executeCommand(command)
    }

    /**
     * Runs docker-compose up on the AWS instance
     * @param {String} publicIp Public IP of the AWS instance
     * @param {Object} config Configuration object
     */
    async _runDockerComposeUp(config) {

        const { AWS_USERNAME } = config;

        const outterQuot = os.type().toLowerCase().includes('windows') ? '"' : "'";

        // Run docker-compose up
        console.log('Connecting to instance and running docker-compose up...')
        const command = this._getSSHCredentials(config) + " " + outterQuot + `cd /home/${AWS_USERNAME}/code/deploy && sudo docker-compose up -d` + outterQuot;
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