/**
 * @file Uploader.js
 * @description This file defines the Uploader class, which is responsible for
 * uploading code to a remote server in a specific way
 */

class Uploader {
    constructor() {
        this._uploadStrategy = null;
    }

    setUploadStrategy(uploadStrategy) {
        this._uploadStrategy = uploadStrategy;
    }

    async createInstance(config) {
        return await this._uploadStrategy.createInstance(config);
    }

    async uploadCode(config) {
        return await this._uploadStrategy.uploadCode(config);
    }

    async configureInstance(config) {
        return await this._uploadStrategy.configureInstance(config);
    }

    async runDockerComposeUp(config) {
        return await this._uploadStrategy.runDockerComposeUp(config);
    }

    async executeCommand(command) {
        return await this._uploadStrategy.executeCommand(command);
    }
}

export default Uploader;