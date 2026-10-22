-- Tabla caché para resúmenes IA de licitaciones
-- Ejecutar contra /var/data/licitaciones/db/licitaciones.duckdb

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
);

CREATE INDEX IF NOT EXISTS idx_ia_resumenes_id ON ia_resumenes(id_contrato);
