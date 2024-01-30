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

  async uploadCode(config) {
    return await this._uploadStrategy.uploadCode(config);
  }

  async createInstance(config) {
    return await this._uploadStrategy.createInstance(config);
  }

  async executeCommand(command) {
    return await this._uploadStrategy.executeCommand(command);
  }
}

export default Uploader;
