import UploadStrategy from "./UploadStrategy.js";
import { executeCommand } from '../utils/utils.js';

class BasicSSHUploadStrategy extends UploadStrategy {

    /**
     * Uploads the code to the remote machine
     * @param {Object} config
     * @returns {Promise<void>}
     */
    async uploadCode(config) {

        const { host, username, port, certRoute, repoPath, remoteRepoPath } = config;

        console.log('Uploading code to local instance...');

        return new Promise(async (resolve, reject) => {
            let command = '';

            if (certRoute)
                command = `scp -P ${port} -i ${certRoute} -r ${repoPath} ${username}@${host}:${remoteRepoPath}`;
            else
                command = `scp -P ${port} -r ${repoPath} ${username}@${host}:${remoteRepoPath}`;

            try {
                await executeCommand(command);
                resolve();
            } catch (error) {
                console.error(error);
                reject(error);
            }
        });

    }

    /**
     * Configures a machine by installing Docker, docker-compose
     * @param {Object} config Configuration object containing the host and username of the machine
     */
    async configureInstance(config) {

        let command = '';

        // // ------------ DOCKER CONFIGURATION ------------
        // Install Docker dependencies
        console.log('Connecting to instance and installing Docker dependencies...');
        command = this._getShhCommand(config) + ` "sudo apt update && sudo apt -y install apt-transport-https ca-certificates curl gnupg2 software-properties-common"`;
        await executeCommand(command);

        // Add Docker's official GPG key
        console.log('Connecting to instance and adding Docker\'s official GPG key...');
        command = this._getShhCommand(config) + ` "curl -fsSL https://download.docker.com/linux/debian/gpg | apt-key add -"`;
        await executeCommand(command);

        // Add Docker repository
        console.log('Connecting to instance and adding Docker\'s repository...');
        command = this._getShhCommand(config) + ` "echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list"`;
        await executeCommand(command);

        // Install Docker Engine
        console.log('Connecting to instance and installing Docker Engine...');
        command = this._getShhCommand(config) + ` "apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io"`;
        await executeCommand(command);

        // Start and enable Docker service
        console.log('Connecting to instance and starting Docker service...');
        command = this._getShhCommand(config) + ` "systemctl enable --now docker"`;
        await executeCommand(command)

        // Verify Docker installation
        console.log('Connecting to instance and verifying Docker installation...');
        command = this._getShhCommand(config) + ` "docker --version"`;
        await executeCommand(command);



        // ------------ DOCKER-COMPOSE CONFIGURATION ------------
        console.log('Connecting to instance and installing curl...');
        command = this._getShhCommand(config) + ` "apt -y install curl wget"`;
        await executeCommand(command)

        // Download the latest release of Docker Compose
        console.log('Connecting to instance and installing docker-compose...');
        command = this._getShhCommand(config) + ` "curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose"`
        await executeCommand(command);

        // Make the Docker Compose binary executable
        console.log('Connecting to instance and making docker-compose executable...');
        command = this._getShhCommand(config) + ` "chmod +x /usr/local/bin/docker-compose"`;
        await executeCommand(command);

        // Verify Docker Compose installation
        console.log('Connecting to instance and verifying docker-compose installation...');
        command = this._getShhCommand(config) + ` "docker-compose --version"`;
        await executeCommand(command);
    }

    /**
     * Runs docker-compose up on the remote machine
     * @param {Object} config Configuration object containing the host and username of the machine
     */
    async runDockerComposeUp(config) {
        const { remoteRepoPath } = config;

        // Run docker-compose up
        console.log('Connecting to instance and running docker-compose up...')
        let command = this._getShhCommand(config) + ` "cd ${remoteRepoPath}/deploy && docker-compose up --build -d"`
        await executeCommand(command)
    }

    /**
     * Gets the SSH command to connect to the remote machine
     * @param {Object} config 
     * @returns {String} The SSH command
     */
    _getShhCommand(config) {
        const { host, port, username, certRoute } = config;

        if (certRoute) {
            return `ssh -o StrictHostKeyChecking=no -p ${port} -i ${certRoute} ${username}@${host}`;
        }

        return `ssh -o StrictHostKeyChecking=no -p ${port} ${username}@${host}`;
    }
}

export default BasicSSHUploadStrategy;