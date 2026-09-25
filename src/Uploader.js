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

  /** The steps a deployment with this config will go through. */
  describe(config) {
    return this._uploadStrategy.describe(config);
  }

  /**
   * Deploys the code, reporting progress through `onEvent`.
   * @param {Object} config
   * @param {Object} [opts] `{ onEvent, signal }`, see UploadStrategy#deploy
   * @returns {Promise<{url: String|null}>}
   */
  async deploy(config, opts) {
    return await this._uploadStrategy.deploy(config, opts);
  }

  /** The steps `updateData` with this config will go through. */
  describeUpdate(config) {
    return this._uploadStrategy.describeUpdate(config);
  }

  /**
   * Reloads the data of a stack that is already running (no rebuild): the data importer
   * runs again and loads only the layers that changed.
   * @param {Object} config
   * @param {Object} [opts] `{ onEvent, signal }`, see UploadStrategy#deploy
   * @returns {Promise<{url: String|null}>}
   */
  async updateData(config, opts) {
    return await this._uploadStrategy.updateData(config, opts);
  }

  /** 1.x compatible: deploys logging to the console, resolves to the URL. */
  async uploadCode(config) {
    return await this._uploadStrategy.uploadCode(config);
  }

  /** Only meaningful for strategies that create machines (AWS). */
  async createInstance(config) {
    if (typeof this._uploadStrategy.createInstance !== "function") {
      throw new Error("The selected strategy cannot create instances");
    }
    return await this._uploadStrategy.createInstance(config);
  }
}

export default Uploader;
