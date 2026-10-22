import { Twitter, Linkedin } from "lucide-react";
import { withBase } from "@/lib/utils";

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t bg-muted/30">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="space-y-4">
            <a href={withBase("/")} className="inline-block">
              <span className="text-sm font-normal tracking-tight text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.02em" }}>
                elicita<span className="text-emerald-600">_</span>
              </span>
            </a>
            <p className="text-sm text-muted-foreground">
              Sistema de inteligencia sobre contratación pública española.
            </p>
            <div className="flex gap-3">
              <a href="https://twitter.com/elicita_es" target="_blank" rel="noopener noreferrer" aria-label="Twitter de elicita_" className="text-muted-foreground hover:text-foreground transition-colors">
                <Twitter className="h-4 w-4" />
              </a>
              <a href="https://linkedin.com/company/elicita" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn de elicita_" className="text-muted-foreground hover:text-foreground transition-colors">
                <Linkedin className="h-4 w-4" />
              </a>
            </div>
          </div>

          {/* Sistema */}
          <div>
            <h3 className="font-semibold mb-4 text-sm">Sistema</h3>
            <ul className="space-y-3">
              <li><a href={withBase("/#funciones")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Funciones</a></li>
              <li><a href={withBase("/#output")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Output</a></li>
              <li><a href={withBase("/#dataset")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Dataset</a></li>
              <li><a href={withBase("/explorer")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Dashboard</a></li>
              <li><a href={withBase("/licitaciones")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Licitaciones por CCAA</a></li>
              <li><a href={withBase("/#mcp")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">MCP para IA</a></li>
            </ul>
          </div>

          {/* Recursos */}
          <div>
            <h3 className="font-semibold mb-4 text-sm">Recursos</h3>
            <ul className="space-y-3">
              <li><a href={withBase("/precios")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Precios</a></li>
              <li><a href={withBase("/rankings")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Rankings</a></li>
              <li><a href={withBase("/fuentes")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Fuentes de datos</a></li>
              <li><a href={withBase("/docs")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Docs</a></li>
              <li><a href={withBase("/docs/metodologia")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Metodología</a></li>
              <li><a href={withBase("/docs/mcp")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">MCP Server</a></li>
              <li><a href={withBase("/cobertura")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Cobertura</a></li>
              <li><a href={withBase("/datos-abiertos")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Datos abiertos</a></li>
              <li><a href={withBase("/blog")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Blog</a></li>
              <li><a href={withBase("/contact")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Contacto</a></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-semibold mb-4 text-sm">Legal</h3>
            <ul className="space-y-3">
              <li><a href={withBase("/aviso-legal")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Aviso legal</a></li>
              <li><a href={withBase("/terms")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Términos de uso</a></li>
              <li><a href={withBase("/privacy")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Privacidad</a></li>
              <li><a href={withBase("/derechos-rgpd")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Derechos RGPD</a></li>
              <li><a href={withBase("/reutilizacion-y-atribucion")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Reutilización CC BY 4.0</a></li>
              <li><a href={withBase("/uso-razonable")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">Uso razonable</a></li>
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="pt-8 border-t flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              © {currentYear} Elicita. Datos públicos, inteligencia propietaria.
            </p>
            <p className="text-xs text-muted-foreground max-w-3xl">
              Elicita no es una fuente oficial ni está afiliado a organismos públicos. Los datos provienen de fuentes públicas (PLACSP, TED UE, BORME, BDNS) y se reutilizan al amparo de la Ley 37/2007. Licencia datos: CC BY 4.0.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
