-- Tabla para almacenar el contenido extraído de pliegos PDF
-- Ejecutar contra /var/data/licitaciones/db/licitaciones.duckdb

CREATE TABLE IF NOT EXISTS pliegos_extraidos (
  id_contrato TEXT NOT NULL,
  url_pdf TEXT,
  pdf_type TEXT,           -- text_based | scanned | image_based | mixed
  markdown TEXT,            -- contenido extraído en markdown
  campos_json TEXT,         -- campos estructurados extraídos por LLM (JSON string)
  modelo_ocr TEXT,          -- pdf-inspector | liteparse | ocr
  modelo_llm TEXT,          -- modelo usado para extracción de campos
  tiempo_extraccion_ms INTEGER,
  fecha_extraccion TIMESTAMP,
  PRIMARY KEY (id_contrato)
);

CREATE INDEX IF NOT EXISTS idx_pliegos_extraidos_id ON pliegos_extraidos(id_contrato);