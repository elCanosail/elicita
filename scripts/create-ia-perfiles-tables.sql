-- Tablas para la Capa 3 de IA: perfiles de usuario y resultados de matching
-- Ejecutar contra /var/data/licitaciones/db/licitaciones.duckdb

CREATE TABLE IF NOT EXISTS ia_perfiles (
  user_id TEXT PRIMARY KEY,
  cpvs TEXT[],
  organismos TEXT[],
  importe_min DOUBLE,
  importe_max DOUBLE,
  comunidad_autonoma TEXT,
  descripcion TEXT,
  creado TIMESTAMP,
  actualizado TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ia_matching_results (
  user_id TEXT,
  id_contrato TEXT,
  score INTEGER,
  motivo TEXT,
  fecha_match TIMESTAMP,
  PRIMARY KEY (user_id, id_contrato)
);

CREATE INDEX IF NOT EXISTS idx_ia_matching_results_user_id ON ia_matching_results(user_id);
CREATE INDEX IF NOT EXISTS idx_ia_matching_results_id_contrato ON ia_matching_results(id_contrato);
