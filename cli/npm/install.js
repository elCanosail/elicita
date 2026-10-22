#!/usr/bin/env node
// postinstall — downloads the prebuilt elicitac binary for the current platform.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = 'elCanosail/elicita';

function getPlatform() {
  const platform = os.platform();
  const arch = os.arch();

  const osMap = {
    linux: 'linux',
    darwin: 'darwin',
    win32: 'windows',
  };

  const archMap = {
    x64: 'amd64',
    arm64: 'arm64',
  };

  const osName = osMap[platform];
  const archName = archMap[arch];

  if (!osName || !archName) {
    throw new Error(`Unsupported platform: ${platform}/${arch}. Supported: linux/darwin/windows on amd64/arm64.`);
  }

  return `${osName}-${archName}`;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest, { mode: 0o755 });
    https
      .get(url, { headers: { Accept: 'application/octet-stream' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, dest).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', reject);
  });
}

async function main() {
  try {
    const binDir = path.join(__dirname, 'bin');
    const binName = os.platform() === 'win32' ? 'elicitac.exe' : 'elicitac';
    const binPath = path.join(binDir, binName);

    // Reuse existing binary if already present.
    if (fs.existsSync(binPath)) {
      console.log(`elicitac binary already exists at ${binPath}`);
      return;
    }

    fs.mkdirSync(binDir, { recursive: true });

    const suffix = getPlatform();
    const assetName = `elicitac-${suffix}`;
    const url = `https://github.com/${REPO}/releases/latest/download/${assetName}`;

    console.log(`Downloading elicitac for ${suffix}...`);
    await download(url, binPath);

    if (os.platform() !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }

    console.log(`Installed elicitac at ${binPath}`);
  } catch (err) {
    console.error(`Failed to download elicitac: ${err.message}`);
    console.error('');
    console.error('You can still build it from source if you have Go 1.22+ installed:');
    console.error('  git clone https://github.com/elCanosail/elicita');
    console.error('  cd elicita/cli');
    console.error('  CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/elicitac ./cmd/elicita');
    console.error('');
    console.error('Or install the binary manually from the latest release:');
    console.error('  https://github.com/elCanosail/elicita/releases/latest');
    process.exit(0);
  }
}

main();
