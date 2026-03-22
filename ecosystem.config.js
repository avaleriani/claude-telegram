module.exports = {
    apps: [{
        name: 'claude-bot',
        script: 'claude-server.js',
        restart_delay: 3000,
        max_restarts: 10,
        autorestart: true,
    }]
};
