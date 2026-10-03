import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { QuantResult } from "./quantize.js";
import { RGB } from "./validate.js";
import { RULE_VERSION } from "./constants.js";

export interface ImageRow {
  id: number;
  pixel_hash: string;
  width: number | null;
  height: number;
  rectangular: number;
  pixel_count: number;
  matrix_json: string;
  created_at: string;
}

export interface QuantRow {
  id: number;
  image_id: number;
  k: number;
  rule_version: string;
  result_json: string;
  created_at: string;
}

let db: DatabaseSync | null = null;

export function openDb(path = "data/app.db"): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pixel_hash TEXT NOT NULL,
      width INTEGER,
      height INTEGER NOT NULL,
      rectangular INTEGER NOT NULL,
      pixel_count INTEGER NOT NULL,
      matrix_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS quantizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id),
      k INTEGER NOT NULL,
      rule_version TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(image_id, k)
    );
  `);
  return db;
}
// 以颜色直方图（含频次）作为身份：像素排列不同但直方图相同 => 同一逻辑输入，
// 从而保证调色板一致并复用记录。
export function histogramHash(rows: RGB[][]): string {
  const counts = new Map<number, number>();
  for (const row of rows)
    for (const [r, g, b] of row) {
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const keys = [...counts.keys()].sort((a, b) => a - b);
  return createHash("sha256")
    .update(keys.map((k) => `${k.toString(16)}:${counts.get(k)}`).join("|"))
    .digest("hex");
}

export interface StoredRef {
  imageId: number;
  isNew: boolean;
}

export function upsertImage(
  rows: RGB[][]
): StoredRef {
  const database = openDb();
  const hash = histogramHash(rows);
  const existing = database
    .prepare("SELECT id FROM images WHERE pixel_hash = ?")
    .get(hash) as { id: number } | undefined;
  if (existing) return { imageId: existing.id, isNew: false };

  const widths = new Set(rows.map((r) => r.length));
  const rectangular = widths.size === 1 ? 1 : 0;
  const width = rectangular ? rows[0].length : null;
  const info = database
    .prepare(
      `INSERT INTO images (pixel_hash, width, height, rectangular, pixel_count, matrix_json)
       VALUES (?,?,?,?,?,?)`
    )
    .run(
      hash,
      width,
      rows.length,
      rectangular,
      rows.reduce((s, r) => s + r.length, 0),
      JSON.stringify(rows)
    );
  return { imageId: Number(info.lastInsertRowid), isNew: true };
}

export function saveQuantization(
  imageId: number,
  k: number,
  result: QuantResult
): number {
  const database = openDb();
  const info = database
    .prepare(
      `INSERT INTO quantizations (image_id, k, rule_version, result_json)
       VALUES (?,?,?,?)
       ON CONFLICT(image_id, k) DO UPDATE SET
         rule_version = excluded.rule_version,
         result_json = excluded.result_json,
         created_at = datetime('now')`
    )
    .run(imageId, k, RULE_VERSION, JSON.stringify(result));
  return Number(info.lastInsertRowid);
}

export function getImage(id: number): ImageRow | undefined {
  return openDb()
    .prepare("SELECT * FROM images WHERE id = ?")
    .get(id) as ImageRow | undefined;
}

export function listImages(): ImageRow[] {
  return openDb()
    .prepare("SELECT * FROM images ORDER BY id")
    .all() as unknown as ImageRow[];
}

export function getQuant(imageId: number, k: number): QuantRow | undefined {
  return openDb()
    .prepare("SELECT * FROM quantizations WHERE image_id = ? AND k = ?")
    .get(imageId, k) as QuantRow | undefined;
}

export function parseResult(row: QuantRow): QuantResult {
  return JSON.parse(row.result_json) as QuantResult;
}
