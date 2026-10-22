module.exports = {
  apps: [{
    name: 'elicita-mcp-v2',
    cwd: '/root/.openclaw/workspace/projects/elicita/mcp-server',
    script: 'dist/v2/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      MCP_V2_HOST: '127.0.0.1',
      MCP_V2_PORT: '4327',
      MCP_V2_PATH: '/mcp-v2',
      NODE_ENV: 'production',
      ELICITA_MCP_V2_ALLOWED_HOSTS: 'elicita.es',
      ELICITA_MCP_V2_ALLOWED_ORIGINS: 'https://elicita.es',
      ELICITA_APPROVED_SNAPSHOT_DIR: '/var/data/licitaciones/market-intelligence/published/technology/latest',
      ELICITA_APPROVED_SNAPSHOT_DIR_CONSTRUCTION: '/var/data/licitaciones/market-intelligence/published/construction/latest',
      ELICITA_APPROVED_SNAPSHOT_DIR_SALUD: '/var/data/licitaciones/market-intelligence/published/salud/latest',
      ELICITA_APPROVED_SNAPSHOT_DIR_ENERGIA: '/var/data/licitaciones/market-intelligence/published/energia/latest',
      ELICITA_APPROVED_SNAPSHOT_DIR_LIMPIEZA: '/var/data/licitaciones/market-intelligence/published/limpieza/latest',
      ELICITA_APPROVED_SNAPSHOT_DIR_DEFENSA: '/var/data/licitaciones/market-intelligence/published/defensa/latest',
      ELICITA_APPROVED_SNAPSHOT_DIR_TRANSPORTE: '/var/data/licitaciones/market-intelligence/published/transporte/latest',
    },
  }],
};
