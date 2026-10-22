-- alertas.sql — Tabla de alertas email para usuarios Elicita
-- Ejecutar una vez: duckdb /var/data/licitaciones/db/licitaciones.duckdb < alertas.sql

CREATE TABLE IF NOT EXISTS alertas (
    id VARCHAR PRIMARY KEY,
    user_id VARCHAR NOT NULL,
    email VARCHAR NOT NULL,
    nif_proveedor VARCHAR,
    cpv VARCHAR,
    organismo VARCHAR,
    created_at TIMESTAMP DEFAULT NOW(),
    last_sent_at TIMESTAMP,
    active BOOLEAN DEFAULT TRUE
);

-- Índice para query por usuario
CREATE INDEX IF NOT EXISTS idx_alertas_user ON alertas(user_id);
-- Índice para scan de alertas activas
CREATE INDEX IF NOT EXISTS idx_alertas_active ON alertas(active) WHERE active = true;