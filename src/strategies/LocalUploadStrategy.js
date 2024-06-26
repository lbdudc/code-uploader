import UploadStrategy from "./UploadStrategy.js";
import { executeCommand } from "../utils/utils.js";

class LocalUploadStrategy extends UploadStrategy {
  async uploadCode(config) {
    // STEP 1: Run docker-compose up --build
    console.log("STEP 1/1 - Running docker-compose up");
    return await this._runDockerComposeUp(config);
  }

  async _runDockerComposeUp(config) {
    const { repoPath } = config;

    // Run docker-compose up
    console.log("Running docker-compose up...");
    let command = `cd ${repoPath}/deploy && docker-compose up --build -d`;

    return await executeCommand(command);
  }
}

export default LocalUploadStrategy;
