import { Button } from "@/components/ui/button";
import { Menu, Terminal } from "lucide-react";
import { withBase } from "@/lib/utils";

export function Header() {
  const navItems = [
    { label: "Buscador", href: withBase("/buscar") },
    { label: "Conectar MCP", href: withBase("/docs/mcp") },
    { label: "Cobertura", href: withBase("/cobertura") },
    { label: "Datos abiertos", href: withBase("/datos-abiertos") },
    { label: "Precios", href: withBase("/precios") },
    { label: "Docs técnicas", href: withBase("/docs") },
    { label: "Blog", href: withBase("/blog") },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <a
        href={withBase("/docs/mcp")}
        className="flex items-center justify-center gap-2 border-b border-emerald-600/20 bg-emerald-600/10 py-1.5 text-xs font-mono text-emerald-400 transition-colors hover:bg-emerald-600/15"
      >
        <Terminal className="h-3 w-3 shrink-0" />
        <span className="text-emerald-300/90">MCP</span>
        <span className="hidden text-emerald-100/60 sm:inline">·</span>
        <span className="hidden text-emerald-100/70 sm:inline">Conecta tu agente de IA a 63M de contratos públicos</span>
        <span className="text-emerald-100/70 sm:hidden">Conecta tu IA a 63M de contratos</span>
        <span className="text-emerald-400">→</span>
      </a>

      <nav className="container flex h-16 items-center justify-between">
        <a href={withBase("/")} className="flex items-center">
          <span className="text-xl font-normal tracking-tight" style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.02em" }}>
            elicita<span className="text-emerald-500" style={{ animation: "blink 1.2s infinite" }}>_</span>
          </span>
        </a>

        <div className="hidden items-center space-x-6 md:flex">
          {navItems.map((item) => (
            <a key={item.label} href={item.href} className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              {item.label}
            </a>
          ))}
        </div>

        <div className="flex items-center space-x-4">
          <Button className="hidden bg-emerald-600 text-white hover:bg-emerald-700 md:inline-flex" asChild>
            <a href={withBase("/docs/mcp")}>Conectar MCP</a>
          </Button>

          <details className="group relative md:hidden">
            <summary
              id="mobile-menu-toggle"
              className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 [&::-webkit-details-marker]:hidden"
              aria-label="Abrir menú"
            >
              <Menu className="h-6 w-6" />
            </summary>
            <div id="mobile-menu" className="absolute right-0 top-12 z-[60] w-[min(20rem,calc(100vw-2rem))] border border-border bg-background p-4 shadow-xl">
              <div className="space-y-1">
                {navItems.map((item) => (
                  <a key={item.label} href={item.href} className="block rounded px-3 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    {item.label}
                  </a>
                ))}
              </div>
              <Button className="mt-3 w-full bg-emerald-600 text-white hover:bg-emerald-700" asChild>
                <a href={withBase("/docs/mcp")}>Conectar MCP</a>
              </Button>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
