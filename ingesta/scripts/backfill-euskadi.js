#!/usr/bin/env node
/**
 * backfill-euskadi.js — Backfill histórico de Euskadi (2011-2023)
 *
 * Descarga los JSON anuales de Open Data Euskadi, mapea los contratos
 * SIN cutoff de fecha, y los añade a euskadi_contracts.json vía merge
 * con retención extendida para no perder el histórico.
 *
 * Uso: node backfill-euskadi.js [--from=2011] [--to=2023] [--dry-run]
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const V2 = require(path.join(__dirname, '..', 'connectors', 'euskadi_v2.js'));

// Ver qué exporta euskadi_v2
console.log('exports:', Object.keys(V2));
