import { Uploader, LocalUploadStrategy } from "../index.js";

const uploader = new Uploader();

// Set the upload strategy to LocalUploadStrategy
uploader.setUploadStrategy(new LocalUploadStrategy());

const config = {
  repoPath: "./code",
};

// Upload code by copying files
await uploader.uploadCode(config);
