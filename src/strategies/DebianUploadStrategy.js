import UploadStrategy from "./UploadStrategy.js";
import { executeCommand, getAbsolutePath } from '../utils/utils.js';
import { compressFolder } from '../utils/zipUtils.js';
import os from 'os';
import { rm } from "fs";

class BasicSSHUploadStrategy extends UploadStrategy {

    /**
     * Uploads the code to the remote machine
     * @param {Object} config
     * @returns {Promise<void>}
     */
    async uploadCode(config) {

        // STEP 1 - Send the code to the remote machine
        console.log('STEP 1/3 - Sending code...');
        await this._sendCode(config);

        // STEP 2 - Configure the remote machine
        console.log('STEP 2/3 - Configuring machine...');
        const isMachineConfigured = await this._checkIfMachineIsConfigured(config);
        if (isMachineConfigured) {
            console.log('Machine already configured!');
        } else {
            console.log('Configuring machine...');
            await this._configureInstance(config);
        }

        // STEP 3 - Run docker-compose up
        console.log('STEP 3/3 - Running docker-compose up...');
        await this._runDockerComposeUp(config);
    }

    /**
     * Sends the code to the remote machine
     * @param {Object} config 
     * @returns 
     */
    async _sendCode(config) {
        const { host, username, port, certRoute, repoPath, remoteRepoPath } = config;

        // Zip the code
        console.log('---- Zipping code...');
        const absPath = await getAbsolutePath(repoPath);
        const zipPath = absPath + '.zip';
        const zipName = absPath.split(/\/|\\/).pop() + '.zip';

        await compressFolder(absPath, `${zipPath}`);

        // Check if the folder exists, if not, create it
        console.log('---- Checking if remote folder exists...');
        let command = this._getShhCommand(config) + ` "if [ ! -d ${remoteRepoPath} ]; then mkdir ${remoteRepoPath}; fi"`;
        await executeCommand(command);


        // Upload the code to the remote machine
        console.log('---- Uploading code to local instance...');
        command = '';
        command += `scp -P ${port}`
        command += certRoute ? ` -i ${certRoute}` : '';
        command += ` ${zipPath} ${username}@${host}:${remoteRepoPath}`;

        try {
            await executeCommand(command);
            console.log('Code uploaded successfully!');
        } catch (error) {
            console.error(error);
            return;
        }

        // Unzip the code
        console.log('---- Unzipping code...');
        // check if unzip is installed, if not, install it
        command = this._getShhCommand(config) + ' "if [ ! -x "$(command -v unzip)" ]; then sudo apt -y install unzip; fi"';
        await executeCommand(command);
        command = this._getShhCommand(config) + ` "unzip -o ${remoteRepoPath}/${zipName} -d ${remoteRepoPath}"`;
        await executeCommand(command);

        // Remove the zip file from the remote machine and the local machine
        console.log('---- Removing zip files...');
        // From remote machine
        command = this._getShhCommand(config) + ` "rm ${remoteRepoPath}/${zipName}"`;
        await executeCommand(command);
        // From local machine
        rm(zipPath, () => { });
    }

    /**
     * Checks if the machine is already configured with Docker and docker-compose
     * @param {Object} config 
     * @returns {Boolean} True if the machine is already configured, false otherwise
     */
    async _checkIfMachineIsConfigured(config) {

        // Check if docker is installed
        let command = this._getShhCommand(config) + ' "dpkg -l | grep docker-ce | wc -l"';
        const dockerInstalled = await executeCommand(command);

        // Ckeck if docker-compose is installed
        command = this._getShhCommand(config) + ' "dpkg -l | grep docker-compose | wc -l"';
        const dockerComposeInstalled = await executeCommand(command);

        return dockerInstalled !== '0' && dockerComposeInstalled !== '0';
    }

    /**
     * Configures a machine by installing Docker, docker-compose
     * @param {Object} config Configuration object containing the host and username of the machine
     */
    async _configureInstance(config) {

        let command = '';

        // Get OS type from node os.type
        const outterQuot = os.type().toLowerCase().includes('windows') ? '"' : "'";
        const innerQuot = os.type().toLowerCase().includes('windows') ? "'" : '"';

        // ------------ DOCKER CONFIGURATION ------------
        console.log('----- Update existing packages -----');
        command = this._getShhCommand(config) + " " + outterQuot + "sudo apt update" + outterQuot;
        await executeCommand(command);

        console.log("----- Installing prerequisite packages which let apt use packages over HTTPS: -----")
        command = this._getShhCommand(config) + " " + outterQuot + "sudo apt -y install apt-transport-https ca-certificates curl gnupg2 software-properties-common" + outterQuot;
        await executeCommand(command);

        console.log("----- Adding Docker’s official GPG key: -----")
        command = this._getShhCommand(config) + " " + outterQuot + "curl -fsSL https://download.docker.com/linux/debian/gpg | sudo apt-key add -" + outterQuot;
        await executeCommand(command);

        console.log("----- Add docker repository to APT sources: -----")
        command = this._getShhCommand(config) + " " + outterQuot + "sudo add-apt-repository 'deb [arch=amd64] https://download.docker.com/linux/debian buster stable'" + outterQuot;
        await executeCommand(command);

        console.log('----- Update existing packages -----');
        command = this._getShhCommand(config) + " " + outterQuot + "sudo apt update" + outterQuot;
        await executeCommand(command);

        console.log("----- Check install from the Docker repo instead of the default Debian repo -----")
        command = this._getShhCommand(config) + " " + outterQuot + "apt-cache policy docker-ce" + outterQuot;
        await executeCommand(command);

        console.log("----- Install Docker: -----")
        command = this._getShhCommand(config) + " " + outterQuot + "sudo apt -y install docker-ce" + outterQuot;
        await executeCommand(command);

        // ------------ DOCKER-COMPOSE CONFIGURATION ------------
        console.log('----- Connecting to instance and installing curl...-----');
        command = this._getShhCommand(config) + " " + outterQuot + "sudo apt -y install curl" + outterQuot;
        await executeCommand(command)

        // Download the latest release of Docker Compose
        console.log('----- Connecting to instance and installing docker-compose...-----');
        command = this._getShhCommand(config) + " " + outterQuot + "sudo curl -L " + innerQuot + "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" + innerQuot + " -o /usr/local/bin/docker-compose" + outterQuot;
        await executeCommand(command);

        // Make the Docker Compose binary executable
        console.log('----- Connecting to instance and making docker-compose executable...-----');
        command = this._getShhCommand(config) + " " + outterQuot + "sudo chmod +x /usr/local/bin/docker-compose" + outterQuot;
        await executeCommand(command);

        // Add user to docker group
        console.log('----- Connecting to instance and adding user to docker group...-----');
        command = this._getShhCommand(config) + " " + outterQuot + `sudo usermod -aG docker ${config.username}` + outterQuot;
        await executeCommand(command);

        // Verify Docker Compose installation
        console.log('----- Connecting to instance and verifying docker-compose installation...-----');
        command = this._getShhCommand(config) + " " + outterQuot + "docker-compose --version" + outterQuot;
        await executeCommand(command);
    }

    /**
     * Runs docker-compose up on the remote machine
     * @param {Object} config Configuration object containing the host and username of the machine
     */
    async _runDockerComposeUp(config) {
        const { remoteRepoPath } = config;
        const outterQuot = os.type().toLowerCase().includes('windows') ? '"' : "'";

        // Run docker-compose up
        console.log('Connecting to instance and running docker-compose up...')
        let command = this._getShhCommand(config) + " " + outterQuot + `cd ${remoteRepoPath}/deploy && docker-compose up --build -d` + outterQuot;
        await executeCommand(command)
    }

    /**
     * Gets the SSH command to connect to the remote machine
     * @param {Object} config 
     * @returns {String} The SSH command
     */
    _getShhCommand(config) {
        const { host, port, username, certRoute } = config;

        let command = `ssh -o StrictHostKeyChecking=no -p ${port}`;
        command += certRoute ? ` -i ${certRoute}` : '';
        command += ` ${username}@${host}`;

        return command;
    }
}

export default BasicSSHUploadStrategy;