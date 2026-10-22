module.exports = {
  apps: [
    {
      name: 'elicita-scheduler',
      script: './scheduler.js',
      cwd: '/root/.openclaw/workspace/projects/elicita/ingesta',
      node_args: '--expose-gc --max-old-space-size=256',
      max_memory_restart: '500M',
      restart_delay: 10000,
      min_uptime: '30s',
      max_restarts: 5,
    },
  ],
};