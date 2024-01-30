import UploadStrategy from "./UploadStrategy.js";
import { executeCommand, getAbsolutePath } from "../utils/utils.js";
import { compressFolder } from "../utils/zipUtils.js";
import os from "os";
import fs, { rmSync } from "fs";

class BasicSSHUploadStrategy extends UploadStrategy {
  /**
   * Uploads the code to the remote machine
   * @param {Object} config
   * @returns {Promise<void>}
   */
  async uploadCode(config) {
    // STEP 1 - Preparing the code to be sent
    console.log("STEP 1/4 - Preparing code...");
    await this._prepareCode(config);

    // STEP 2 - Send the code to the remote machine
    console.log("STEP 2/4 - Sending code...");
    await this._sendCode(config);

    // STEP 3 - Configure the remote machine
    console.log("STEP 3/4 - Configuring machine...");
    const isMachineConfigured = await this._checkIfMachineIsConfigured(config);
    if (isMachineConfigured) {
      console.log("Machine already configured!");
    } else {
      console.log("Configuring machine...");
      await this._configureInstance(config);
    }

    // STEP 4 - Run docker-compose up
    console.log("STEP 4/4 - Running docker-compose up...");
    await this._runDockerComposeUp(config);
  }

  /**
   * Prepares the code to be sent to the remote machine
   * @param {Object} config
   */
  async _prepareCode(config) {
    const { forceBuild } = config;

    // If forceBuild is not true, skip this step
    if (!!forceBuild) {
      // Build the client
      await this._buildClient(config);
    }
  }

  async _buildClient(config) {
    const { repoPath } = config;

    // Check if the client has node_modules folder
    const absPath = await getAbsolutePath(repoPath);
    const clientPath = absPath + "/client";

    const nodeModulesPath = clientPath + "/node_modules";

    console.log(nodeModulesPath);

    // Get the node version from .nvmrc file
    const nodeVersion = fs.readFileSync(clientPath + "/.nvmrc", "utf8").trim();

    // If it doesn't have node_modules folder, install the dependencies
    if (!fs.existsSync(nodeModulesPath)) {
      console.log("---- Installing dependencies...");
      const command = `cd ${clientPath} && npm_config_node_version=${nodeVersion} npm install`;
      try {
        await executeCommand(command);
      } catch (error) {
        console.error(error);
        return;
      }
    } else {
      console.log("---- Dependencies already installed!");
    }

    // Build the client
    console.log("---- Building client...");
    const command = `cd ${clientPath} && npm_config_node_version=${nodeVersion} npm run build`;
    try {
      await executeCommand(command);
    } catch (error) {
      console.error(error);
      return;
    }

    // Remove the node_modules folder
    console.log("---- Removing node_modules folder...");
    rmSync(nodeModulesPath, { recursive: true }, () => {});

    // Delete the client service from docker-compose.yml
    console.log("---- Comment client service from docker-compose.yml...");
    const dockerComposePath = absPath + "/deploy/docker-compose.yml";
    const dockerCompose = fs.readFileSync(dockerComposePath, "utf8");
    try {
      // Comment all lines of the client service
      const clientService = dockerCompose.match(
        /client:\n\s+build:\n\s+context:.*\n\s+dockerfile:.*\n\s+container_name:.*\n\s+networks:\n\s+- local\n\s+volumes:\n\s+-.*\n/g,
      )[0];
      const newDockerCompose = dockerCompose.replace(
        clientService,
        clientService
          .split("\n")
          .map((line) => `# ${line}`)
          .join("\n"),
      );
      fs.writeFileSync(dockerComposePath, newDockerCompose, "utf8");
    } catch (error) {
      console.log("---- Docker-compose not modified!");
      return;
    }
  }

  /**
   * Sends the code to the remote machine
   * @param {Object} config
   * @returns
   */
  async _sendCode(config) {
    const { host, username, port, certRoute, repoPath, remoteRepoPath } =
      config;

    const outterQuot = os.type().toLowerCase().includes("windows") ? '"' : "'";
    const innerQuot = os.type().toLowerCase().includes("windows") ? "'" : '"';

    // Zip the code
    console.log("---- Zipping code...");
    const absPath = await getAbsolutePath(repoPath);
    const zipPath = absPath + ".zip";
    const zipName = absPath.split(/\/|\\/).pop() + ".zip";

    await compressFolder(absPath, `${zipPath}`);

    // Check if the folder exists, if not, create it
    console.log("---- Checking if remote folder exists...");
    let command =
      this._getShhCommand(config) +
      ` ${outterQuot}if [ ! -d ${remoteRepoPath} ]; then mkdir ${remoteRepoPath}; fi${outterQuot}`;
    await executeCommand(command);

    // If docker is installed, do a docker-compose down first
    console.log("---- Deleting contents of remote folder...");
    command =
      this._getShhCommand(config) +
      ` ${outterQuot}if [ -x ${innerQuot}$(command -v docker)${innerQuot} ]; then cd ${remoteRepoPath}/deploy && docker-compose down -v; fi${outterQuot}`;
    await executeCommand(command);

    // Delete the contents of the remote folder
    command =
      this._getShhCommand(config) +
      ` ${outterQuot}sudo rm -rf ${remoteRepoPath}/*${outterQuot}`;
    await executeCommand(command);

    // Upload the code to the remote machine
    console.log("---- Uploading code to local instance...");
    command = "";
    command += `scp -P ${port}`;
    command += certRoute ? ` -i ${certRoute}` : "";
    command += ` ${zipPath} ${username}@${host}:${remoteRepoPath}`;

    try {
      await executeCommand(command);
      console.log("Code uploaded successfully!");
    } catch (error) {
      console.error(error);
      return;
    }

    // Unzip the code
    console.log("---- Unzipping code...");
    // check if unzip is installed, if not, install it
    command =
      this._getShhCommand(config) +
      ` ${outterQuot}if [ ! -x ${innerQuot}$(command -v unzip)${innerQuot} ]; then sudo apt -y install unzip; fi${outterQuot}`;
    await executeCommand(command);
    command =
      this._getShhCommand(config) +
      ` ${outterQuot}unzip -o ${remoteRepoPath}/${zipName} -d ${remoteRepoPath}${outterQuot}`;
    await executeCommand(command);

    // Remove the zip file from the remote machine and the local machine
    console.log("---- Removing zip files...");
    // From remote machine
    command =
      this._getShhCommand(config) + ` "rm ${remoteRepoPath}/${zipName}"`;
    await executeCommand(command);
    // From local machine
    rmSync(zipPath, { recursive: true }, () => {});
  }

  /**
   * Checks if the machine is already configured with Docker and docker-compose
   * @param {Object} config
   * @returns {Boolean} True if the machine is already configured, false otherwise
   */
  async _checkIfMachineIsConfigured(config) {
    // Check if docker is installed
    let command =
      this._getShhCommand(config) + ' "dpkg -l | grep docker-ce | wc -l"';
    const dockerInstalled = await executeCommand(command);
    const isDockerInstalled = dockerInstalled.stdout.trim() !== "0";

    // Ckeck if docker-compose is installed
    command =
      this._getShhCommand(config) + ' "dpkg -l | grep docker-compose | wc -l"';
    const dockerComposeInstalled = await executeCommand(command);
    const isDockerComposeInstalled =
      dockerComposeInstalled.stdout.trim() !== "0";

    return isDockerInstalled && isDockerComposeInstalled;
  }

  /**
   * Configures a machine by installing Docker, docker-compose
   * @param {Object} config Configuration object containing the host and username of the machine
   */
  async _configureInstance(config) {
    let command = "";

    // Get OS type from node os.type
    const outterQuot = os.type().toLowerCase().includes("windows") ? '"' : "'";
    const innerQuot = os.type().toLowerCase().includes("windows") ? "'" : '"';

    // ------------ DOCKER CONFIGURATION ------------
    console.log("----- Update existing packages -----");
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo apt update" +
      outterQuot;
    await executeCommand(command);

    console.log(
      "----- Installing prerequisite packages which let apt use packages over HTTPS: -----",
    );
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo apt -y install apt-transport-https ca-certificates curl gnupg2 software-properties-common" +
      outterQuot;
    await executeCommand(command);

    console.log("----- Adding Docker’s official GPG key: -----");
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "curl -fsSL https://download.docker.com/linux/debian/gpg | sudo apt-key add -" +
      outterQuot;
    await executeCommand(command);

    console.log("----- Add docker repository to APT sources: -----");
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo add-apt-repository " +
      innerQuot +
      "deb [arch=amd64] https://download.docker.com/linux/debian buster stable" +
      innerQuot +
      outterQuot;
    await executeCommand(command);

    console.log("----- Update existing packages -----");
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo apt update" +
      outterQuot;
    await executeCommand(command);

    console.log(
      "----- Check install from the Docker repo instead of the default Debian repo -----",
    );
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo apt-cache policy docker-ce" +
      outterQuot;
    await executeCommand(command);

    console.log("----- Install Docker: -----");
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo apt -y install docker-ce" +
      outterQuot;
    await executeCommand(command);

    // ------------ DOCKER-COMPOSE CONFIGURATION ------------
    console.log("----- Connecting to instance and installing curl...-----");
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo apt -y install curl" +
      outterQuot;
    await executeCommand(command);

    // Download the latest release of Docker Compose
    console.log(
      "----- Connecting to instance and installing docker-compose...-----",
    );
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-`uname -s`-`uname -m` -o /usr/local/bin/docker-compose" +
      outterQuot;
    await executeCommand(command);

    // Make the Docker Compose binary executable
    console.log(
      "----- Connecting to instance and making docker-compose executable...-----",
    );
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "sudo chmod +x /usr/local/bin/docker-compose" +
      outterQuot;
    await executeCommand(command);

    // Add user to docker group
    console.log(
      "----- Connecting to instance and adding user to docker group...-----",
    );
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      `sudo usermod -aG docker ${config.username}` +
      outterQuot;
    await executeCommand(command);

    // Verify Docker Compose installation
    console.log(
      "----- Connecting to instance and verifying docker-compose installation...-----",
    );
    command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      "docker-compose --version" +
      outterQuot;
    await executeCommand(command);
  }

  /**
   * Runs docker-compose up on the remote machine
   * @param {Object} config Configuration object containing the host and username of the machine
   */
  async _runDockerComposeUp(config) {
    const { remoteRepoPath } = config;
    const outterQuot = os.type().toLowerCase().includes("windows") ? '"' : "'";

    // Run docker-compose up
    console.log("Connecting to instance and running docker-compose up...");
    let command =
      this._getShhCommand(config) +
      " " +
      outterQuot +
      `cd ${remoteRepoPath}/deploy && docker-compose up --build -d` +
      outterQuot;
    await executeCommand(command);
  }

  /**
   * Gets the SSH command to connect to the remote machine
   * @param {Object} config
   * @returns {String} The SSH command
   */
  _getShhCommand(config) {
    const { host, port, username, certRoute } = config;

    let command = `ssh -o StrictHostKeyChecking=no -p ${port}`;
    command += certRoute ? ` -i ${certRoute}` : "";
    command += ` ${username}@${host}`;

    return command;
  }
}

export default BasicSSHUploadStrategy;
