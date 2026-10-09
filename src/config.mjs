// Configuration: one JSON file in the "home" folder. Nothing outside it is ever deleted by this tool.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  busyWindowMs: 180000,      // a runtime whose session file changed this recently is considered busy: its stale process is not ended yet
  recycleCooldownMs: 600000, // never end the same conversation's process on the same runtime twice within this time
  syncIntervalMs: 20000,
  recycle: true,             // end stale per-conversation processes in the other runtimes (see README, "How context is kept in sync")
});

export function homeDir(env = process.env) {
  return resolve(env.CCM_HOME || join(env.USERPROFILE || env.HOME || '.', 'ClaudeRuntimes'));
}
export const configPath = home => join(home, 'ccm.json');

export function defaultPrimaryUserData(env = process.env) {
  return join(env.APPDATA || join(env.USERPROFILE || '.', 'AppData', 'Roaming'), 'Claude');
}

export function loadConfig(home = homeDir()) {
  const file = configPath(home);
  if (!existsSync(file)) return { home, primary: { name: 'A', userData: defaultPrimaryUserData() }, runtimes: [], ...DEFAULTS };
  const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  return { home, ...DEFAULTS, ...raw, primary: { name: 'A', userData: defaultPrimaryUserData(), ...(raw.primary || {}) }, runtimes: raw.runtimes || [] };
}

export function saveConfig(cfg) {
  mkdirSync(cfg.home, { recursive: true });
  const { home, ...rest } = cfg;
  writeFileSync(configPath(home), JSON.stringify(rest, null, 2) + '\n');
}

const NAME = /^[A-Za-z0-9_-]{1,24}$/;
export function validateName(name) {
  if (!NAME.test(name || '')) throw new Error(`Invalid runtime name "${name}" (letters, digits, - and _ only, max 24).`);
}

/** All runtimes including the primary, each with its userData directory. */
export function allRuntimes(cfg) {
  return [{ name: cfg.primary.name, userData: cfg.primary.userData, primary: true }, ...cfg.runtimes.map(r => ({ ...r, userData: r.profile }))];
}

export function addRuntime(cfg, name, profile) {
  validateName(name);
  if (allRuntimes(cfg).some(r => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`Runtime "${name}" already exists.`);
  const p = resolve(profile || join(cfg.home, name, 'profile'));
  if (allRuntimes(cfg).some(r => resolve(r.userData).toLowerCase() === p.toLowerCase())) throw new Error(`Profile folder ${p} is already used by another runtime.`);
  const rt = { name, profile: p, color: pickColor(cfg.runtimes.length) };
  cfg.runtimes.push(rt);
  return rt;
}

const COLORS = ['#2e8b57', '#c0392b', '#2980b9', '#8e44ad', '#d35400', '#16a085', '#7f8c8d', '#b7950b'];
function pickColor(i) { return COLORS[i % COLORS.length]; }
