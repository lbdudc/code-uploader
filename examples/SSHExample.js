import { Uploader, DebianUploadStrategy } from '../index.js';

const uploader = new Uploader();
uploader.setUploadStrategy(new DebianUploadStrategy());

const config = {
    host: '127.0.0.1',
    port: 22,
    username: 'vboxuser',
    certRoute: '../id_rsa', // Optional but recommended
    repoPath: '../code',
    remoteRepoPath: '/home/vboxuser/code',
};

// Upload code by SCP
await uploader.uploadCode(config);

// Install Docker and docker-compose 
await uploader.configureInstance(config);

// Run docker-compose up
await uploader.runDockerComposeUp(config);