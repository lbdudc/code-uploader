import UploadStrategy from "./UploadStrategy.js";
import { executeCommand } from '../utils/utils.js';

class BasicSSHUploadStrategy extends UploadStrategy {
    async uploadCode(config) {

        const { host, username, REPO_DIRECTORY, REMOTE_REPO_PATH } = config;

        console.log('Uploading code to local instance...');

        return new Promise(async (resolve, reject) => {
            const command = `scp -r ${REPO_DIRECTORY} ${username}@${host}:${REMOTE_REPO_PATH}`;

            try {
                await executeCommand(command);
                resolve();
            } catch (error) {
                console.error(error);
                reject(error);
            }
        });

    }
}

export default BasicSSHUploadStrategy;