// Helper para ejecutar archivos SQL contra DuckDB
const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';
const sqlFile = process.argv[2];

if (!sqlFile) {
  console.error('Uso: node run-sql.js <archivo.sql>');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(sqlFile), 'utf-8');
const db = new duckdb.Database(DB_PATH);
db.exec(sql, (err) => {
  if (err) {
    console.error('Error ejecutando SQL:', err.message);
    process.exit(1);
  }
  console.log('SQL ejecutado correctamente.');
  db.close();
});
