# @elcanosail/elicitac

[![npm](https://img.shields.io/npm/v/@elcanosail/elicitac)](https://www.npmjs.com/package/@elcanosail/elicitac)

Agent-friendly CLI for Spanish public procurement data — 66.4M+ records.

This package downloads the correct prebuilt Go binary for your platform during installation.

## Install

```bash
# Global install
npm install -g @elcanosail/elicitac

# Or run without installing
npx @elcanosail/elicitac search "mantenimiento HVAC" --json --limit 10
```

## Usage

Authenticate once:

```bash
elicitac auth --key elc_xxxxxxxx
```

Search contracts:

```bash
elicitac search "Telefónica" --nif A78901234 --desde 2024 --json
```

Company profile:

```bash
elicitac org B15044357 --json
```

Stats and predictions:

```bash
elicitac stats --cpv 72 --fuente PLACE --json
```

## Supported platforms

- Linux (amd64, arm64)
- macOS (amd64, arm64)
- Windows (amd64)

If no prebuilt binary is available for your platform, the postinstall script prints manual build instructions.

## License

MIT
