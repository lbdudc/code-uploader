import { Uploader, BasicSSHUploadStrategy } from '../index.js';

const uploader = new Uploader();
uploader.setUploadStrategy(new BasicSSHUploadStrategy());

// // Upload code by SSH
await uploader.uploadCode({
    host: 'localhost',
    username: 'user',
    REPO_DIRECTORY: '../code',
    REMOTE_REPO_PATH: 'C:\\Users\\user\\Desktop\\test',
});