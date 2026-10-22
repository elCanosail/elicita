/**
 * Crea la tabla ia_resumenes en DuckDB.
 * Uso: node scripts/create-ia-resumenes-table.js
 *
 * NOTA: DuckDB no permite conexiones simultáneas de lectura/escritura.
 * Este script debe ejecutarse cuando el proceso principal (web) no tenga
 * abierta la base de datos en modo exclusivo, o usando una copia.
 */
const duckdb = require('duckdb');
const path = require('path');

const DB_PATH = process.env.DUCKDB_PATH || '/var/data/licitaciones/db/licitaciones.duckdb';

const db = new duckdb.Database(DB_PATH);
db.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");
const conn = db.connect();
conn.exec("SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false;");

conn.exec(`
  CREATE TABLE IF NOT EXISTS ia_resumenes (
    id_contrato TEXT NOT NULL,
    modelo TEXT NOT NULL,
    resumen TEXT NOT NULL,
    sector TEXT,
    tipo TEXT,
    importe_detectado DOUBLE,
    estado_detectado TEXT,
    fecha_generacion TIMESTAMP,
    PRIMARY KEY (id_contrato)
  )
`);

conn.exec('CREATE INDEX IF NOT EXISTS idx_ia_resumenes_id ON ia_resumenes(id_contrato);');

conn.all('SELECT count(*) as total FROM ia_resumenes', (err, rows) => {
  if (err) {
    console.error('[create-ia-resumenes-table] Error:', err.message);
    process.exit(1);
  }
  console.log(`[create-ia-resumenes-table] Tabla creada/verificada. Filas actuales: ${rows[0].total}`);
  conn.close();
  db.close();
});
