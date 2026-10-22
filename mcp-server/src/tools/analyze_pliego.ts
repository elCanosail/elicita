import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElicitaApiConfig, ToolResult } from '../lib/types.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.doc', '.docx', '.docm',
  '.pdf',
  '.xls', '.xlsx', '.xlsm', '.csv',
  '.ppt', '.pptx', '.ppsx',
  '.odt', '.ods', '.odp',
  '.rtf',
  '.epub'
]);

const inputSchema = z.object({
  file_path: z.string().optional().describe('Ruta absoluta al archivo del pliego en el servidor.'),
  file_base64: z.string().optional().describe('Contenido del archivo codificado en base64.'),
  file_name: z.string().min(1).describe('Nombre original del archivo con extensión (p. ej. "pliego.docx").')
});

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_MARKDOWN_CHARS = 5_000;

interface ExtractedFields {
  criterios_adjudicacion?: Array<{
    nombre?: string;
    peso_pct?: number;
    subtipo?: string;
  }>;
  solvencia_economica?: string;
  solvencia_tecnica?: string;
  plazo_ejecucion?: string;
  garantia_definitiva?: string;
  procedimiento?: string;
  plazo_presentacion?: string;
  notas?: string;
}

interface AnalyzeResult {
  markdown: string;
  campos_extraidos: ExtractedFields | null;
  metadata: {
    file_name: string;
    file_type: string;
    size_bytes: number;
    conversion_ms: number;
    llm_model: string;
    total_tokens?: number;
    llm_error?: string;
  };
}

export function registerAnalyzePliegoTool(server: McpServer, _config: ElicitaApiConfig): void {
  server.registerTool(
    'analyze_pliego',
    {
      title: 'Analizar pliego de contratación',
      description:
        'Convierte un pliego de contratación pública (.docx, .pdf, .xlsx, etc.) a Markdown con anydoc ' +
        'y extrae campos estructurados (criterios de adjudicación, solvencia, plazos, garantías, procedimiento) usando un modelo LLM. ' +
        'Acepta file_path (ruta local) o file_base64 (contenido en base64) más file_name.',
      inputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args): Promise<ToolResult> => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'elicita-pliego-'));
      let inputPath: string | null = null;

      try {
        // Validar que hay exactamente una fuente de datos
        if (!args.file_path && !args.file_base64) {
          return { content: [{ type: 'text', text: 'Debes proporcionar file_path o file_base64.' }], isError: true };
        }
        if (args.file_path && args.file_base64) {
          return { content: [{ type: 'text', text: 'Proporciona solo file_path o file_base64, no ambos.' }], isError: true };
        }

        const ext = getExtension(args.file_name);
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          return {
            content: [
              {
                type: 'text',
                text: `Formato no soportado: "${ext}". Formatos válidos: ${Array.from(SUPPORTED_EXTENSIONS).sort().join(', ')}.`
              }
            ],
            isError: true
          };
        }

        // Resolver path final
        if (args.file_path) {
          inputPath = args.file_path;
          try {
            // ⚠️ Whitelist de directorios: solo /tmp, /var/tmp y /uploads (evita path traversal a /etc, /root, etc.)
            const resolved = resolve(inputPath);
            const allowedPrefixes = [
              join(tmpdir(), 'elicita-pliego-'),
              join(tmpdir(), ''),
              '/var/tmp/',
              '/uploads/',
            ];
            const insideAllowed = allowedPrefixes.some((dir) => resolved.startsWith(dir));
            if (!insideAllowed) {
              return { content: [{ type: 'text', text: `Ruta no permitida: solo se aceptan archivos en /tmp, /var/tmp o /uploads. Path: ${inputPath}` }], isError: true };
            }
            const info = statSync(resolved);
            if (!info.isFile()) {
              return { content: [{ type: 'text', text: `La ruta no es un archivo: ${inputPath}` }], isError: true };
            }
            if (info.size > MAX_SIZE_BYTES) {
              return { content: [{ type: 'text', text: `Archivo demasiado grande: ${info.size} bytes (máximo ${MAX_SIZE_BYTES}).` }], isError: true };
            }
            inputPath = resolved;
          } catch (err) {
            return { content: [{ type: 'text', text: `No se pudo leer el archivo: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
          }
        } else {
          // Decodificar base64 a fichero temporal
          const safeName = args.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
          inputPath = join(tmpDir, safeName);
          try {
            const buffer = Buffer.from(args.file_base64!, 'base64');
            if (buffer.length > MAX_SIZE_BYTES) {
              return { content: [{ type: 'text', text: `Archivo decodificado demasiado grande: ${buffer.length} bytes (máximo ${MAX_SIZE_BYTES}).` }], isError: true };
            }
            writeFileSync(inputPath, buffer);
          } catch (err) {
            return { content: [{ type: 'text', text: `Error al escribir archivo temporal: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
          }
        }

        const sizeBytes = statSync(inputPath).size;

        // anydoc a Markdown — execFileSync (sin shell): args como array, sin inyección de comandos
        const start = Date.now();
        let markdown: string;
        try {
          markdown = execFileSync('anydoc', [inputPath], {
            encoding: 'utf8',
            maxBuffer: 100 * 1024 * 1024,
            timeout: 120_000
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `Error al convertir el documento con anydoc: ${message}` }], isError: true };
        }
        const conversionMs = Date.now() - start;

        // Extracción con LLM: falla suave
        let extracted: ExtractedFields | null = null;
        let llmModel = 'none';
        let totalTokens: number | undefined;
        let llmError: string | undefined;

        try {
          const extraction = await extractFields(markdown.slice(0, MAX_MARKDOWN_CHARS));
          extracted = extraction.fields;
          llmModel = extraction.model;
          totalTokens = extraction.totalTokens;
        } catch (err) {
          llmError = err instanceof Error ? err.message : String(err);
          llmModel = 'deepseek-v4-flash (failed)';
        }

        const result: AnalyzeResult = {
          markdown,
          campos_extraidos: extracted,
          metadata: {
            file_name: args.file_name,
            file_type: ext,
            size_bytes: sizeBytes,
            conversion_ms: conversionMs,
            llm_model: llmModel,
            ...(totalTokens !== undefined && { total_tokens: totalTokens }),
            ...(llmError && { llm_error: llmError })
          }
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } finally {
        // Limpiar temporales
        try {
          if (inputPath && args.file_base64) {
            unlinkSync(inputPath);
          }
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignorar errores de limpieza
        }
      }
    }
  );
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(idx).toLowerCase() : '';
}

interface LlmExtraction {
  fields: ExtractedFields | null;
  model: string;
  totalTokens?: number;
}

async function extractFields(markdownSnippet: string): Promise<LlmExtraction> {
  const apiKey = readApiKey();
  const model = 'deepseek-v4-flash';

  const prompt = `Analiza este pliego de contratación pública española. Extrae SOLO JSON válido:
{
  "criterios_adjudicacion": [{"nombre": "...", "peso_pct": 0, "subtipo": "formula/juicio"}],
  "solvencia_economica": "...",
  "solvencia_tecnica": "...",
  "plazo_ejecucion": "...",
  "garantia_definitiva": "...",
  "procedimiento": "...",
  "plazo_presentacion": "...",
  "notas": "..."
}
TEXTO:
${markdownSnippet}`;

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'Eres un asistente especializado en pliegos de contratación pública española. Responde únicamente con JSON válido sin explicaciones.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1,
    max_tokens: 2048
  };

  try {
    const response = await fetch('https://api.nan.builders/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
      model?: string;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const fields = parseJsonFromContent(content);

    return {
      fields,
      model: data.model || model,
      totalTokens: data.usage?.total_tokens
    };
  } catch (err) {
    // Fallback a Ollama Cloud
    return await extractFieldsOllama(markdownSnippet);
  }
}

async function extractFieldsOllama(markdownSnippet: string): Promise<LlmExtraction> {
  const apiKey = process.env.OLLAMA_API_KEY || '';
  const model = 'glm-5.2:cloud';

  const prompt = `Analiza este pliego de contratación pública española. Extrae SOLO JSON válido:
{
  "criterios_adjudicacion": [{"nombre": "...", "peso_pct": 0, "subtipo": "formula/juicio"}],
  "solvencia_economica": "...",
  "solvencia_tecnica": "...",
  "plazo_ejecucion": "...",
  "garantia_definitiva": "...",
  "procedimiento": "...",
  "plazo_presentacion": "...",
  "notas": "..."
}
TEXTO:
${markdownSnippet}`;

  const response = await fetch('https://ollama.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'Eres un asistente especializado en pliegos de contratación pública española. Responde únicamente con JSON válido sin explicaciones.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2048
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama fallback error ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
    model?: string;
  };

  const content = data.choices?.[0]?.message?.content ?? '';
  return {
    fields: parseJsonFromContent(content),
    model: data.model || 'ollama/glm-5.2:cloud',
    totalTokens: data.usage?.total_tokens
  };
}

function parseJsonFromContent(content: string): ExtractedFields | null {
  const trimmed = content.trim();

  // 1. Si empieza directamente por { o [
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as ExtractedFields;
    } catch {
      // continuar a extracción por bloque
    }
  }

  // 2. Buscar bloque markdown ```json ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as ExtractedFields;
    } catch {
      // continuar
    }
  }

  // 3. Buscar primer objeto JSON entre llaves
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as ExtractedFields;
    } catch {
      // continuar
    }
  }

  return null;
}

function readApiKey() {
  try {
    return readFileSync('/root/.nan_api_key', 'utf8').trim();
  } catch {
    throw new Error('No se pudo leer la API key de NaN Builders en /root/.nan_api_key');
  }
}

