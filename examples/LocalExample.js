import { Uploader, LocalUploadStrategy } from '../index.js';

const uploader = new Uploader();

// Set the upload strategy to LocalUploadStrategy
uploader.setUploadStrategy(new LocalUploadStrategy());

const config = {
    repoPath: './code',
    forceBuild: true,
};

// Upload code by copying files
await uploader.uploadCode(config);