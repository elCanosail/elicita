export const MCP_ENDPOINT = 'https://elicita.es/mcp';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const MCP_TOOLS = [
  {
    name: 'search_licitaciones',
    summary: 'Busca licitaciones y contratos por texto, CPV, importe, estado, fuente, NIF y año.',
    prompt: 'Con una API key Pro, busca licitaciones de ciberseguridad publicadas este año por encima de 100.000 €. Resume las cinco más relevantes con organismo, importe, estado, fecha y enlace a la fuente.',
  },
  {
    name: 'get_stats',
    summary: 'Consulta el tamaño histórico del dataset y su última actualización global.',
    prompt: 'Consulta las estadísticas de Elicita y explícame qué universo histórico cubre antes de sacar conclusiones.',
  },
  {
    name: 'get_cobertura',
    summary: 'Comprueba fuentes activas, periodicidad y frescura antes de investigar.',
    prompt: 'Comprueba la cobertura de fuentes de Elicita. Dime qué fuentes están activas, su periodicidad y cuándo se actualizó cada una.',
  },
  {
    name: 'search_cpv',
    summary: 'Encuentra códigos CPV en español para convertir una necesidad en una búsqueda reproducible.',
    prompt: 'Busca los códigos CPV más útiles para servicios de ciberseguridad y propón una consulta posterior de licitaciones con ellos.',
  },
] as const;
