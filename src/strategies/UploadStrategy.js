import { executeCommand } from '../utils/utils.js';

/**
 * @file UploadStrategy.js
 * @description This file defines the UploadStrategy class, which is responsible for 
 * defining the interface for the different upload strategies
 */
class UploadStrategy {
    createInstance(config) {
        throw new Error('This method must be overwritten!');
    }

    uploadCode(dest, folder) {
        throw new Error('This method must be overwritten!');
    }

    configureInstance(config) {
        throw new Error('This method must be overwritten!');
    }

    runDockerComposeUp(config) {
        throw new Error('This method must be overwritten!');
    }

    // It is not necessary to overwrite this method
    executeCommand(command) {
        executeCommand(command);
    }
}

export default UploadStrategy;