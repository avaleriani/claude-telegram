module.exports = {
    apps: [{
        name: 'claude-bot-dev',
        script: 'claude-server.js',
        watch: ['claude-server.js'],
        ignore_watch: ['node_modules', 'state.json', '.env'],
        restart_delay: 1000,
        autorestart: true,
        node_args: '--no-deprecation',
    }]
};
