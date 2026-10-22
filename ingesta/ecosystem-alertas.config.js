const fs = require('fs');
const envFile = fs.readFileSync('/root/.openclaw/workspace/projects/elicita/web/.env', 'utf-8');
const getEnv = (key) => {
  const m = envFile.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim() : '';
};

module.exports = {
  apps: [{
    name: 'elicita-alertas',
    script: './alertas-worker.js',
    cron_restart: '0 7 * * *',
    autorestart: false,
    time: true,
    env: {
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: getEnv('CLERK_SECRET_KEY'),
      RESEND_API_KEY: getEnv('RESEND_API_KEY'),
      DUCKDB_PATH: '/var/data/licitaciones/db/licitaciones.duckdb',
      ELICITA_URL: 'https://elicita.es',
    },
  }],
};