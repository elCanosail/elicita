module.exports = {
  apps: [{
    name: 'elicita-mcp',
    cwd: '/root/.openclaw/workspace/projects/elicita/mcp-server',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      HOST: '127.0.0.1',
      PORT: '4326',
      NODE_ENV: 'production',
      ELICITA_APPROVED_SNAPSHOT_DIR: '/var/data/licitaciones/market-intelligence/published/technology/snapshots/technology-20260915-153519Z'
    }
  }]
}
