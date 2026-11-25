#!/usr/bin/env node
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD_DIST = path.join(ROOT, 'payload', 'dist');

const {
  PAYLOAD_FILES,
  packHakimiAsar: corePackHakimiAsar,
  verifyHeaderMetadataPreserved,
} = require(path.join(PAYLOAD_DIST, 'hakimi-asar-packer'));

function parseArgs(argv) {
  const opts = {
    srcAsar: null,
    destAsar: null,
    stateDir: null,
    clientLang: 'zh-CN',
    hasExplicitLang: false,
    hashOut: null,
    iconPng: null,
    forceConfig: false,
    skipConfig: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--src-asar') {
      opts.srcAsar = argv[++i];
    } else if (arg === '--dest-asar') {
      opts.destAsar = argv[++i];
    } else if (arg === '--state-dir') {
      opts.stateDir = argv[++i];
    } else if (arg === '--client-lang') {
      opts.clientLang = argv[++i];
      opts.hasExplicitLang = true;
    } else if (arg === '--hash-out') {
      opts.hashOut = argv[++i];
    } else if (arg === '--icon-png') {
      opts.iconPng = argv[++i];
    } else if (arg === '--force-config') {
      opts.forceConfig = true;
    } else if (arg === '--skip-config') {
      opts.skipConfig = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/pack-hakimi-asar.js --src-asar <path> --dest-asar <path> [--state-dir <dir>] [--client-lang <zh-CN|en>] [--hash-out <file>] [--icon-png <file>] [--force-config] [--skip-config]'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.srcAsar) throw new Error('Missing required --src-asar');
  if (!opts.destAsar) throw new Error('Missing required --dest-asar');
  return opts;
}

function packHakimiAsar(rawOpts = {}) {
  return corePackHakimiAsar({
    payloadDistDir: PAYLOAD_DIST,
    ...rawOpts,
  });
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const res = packHakimiAsar(opts);
  process.stdout.write(`${res.sha256}\n`);
}

module.exports = {
  PAYLOAD_FILES,
  packHakimiAsar,
  verifyHeaderMetadataPreserved,
};
