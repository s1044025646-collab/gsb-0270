import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import { RULE_VERSION } from "./limits.js";
import { quantize } from "./quantize.js";
import type {
  QuantizationResult,
  Rgb,
  RgbMatrix,
  SplitStep,
  StoredResult,
} from "./types.js";
import { validateK, validateMatrix } from "./validation.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return JSON.stringify(value);
}

async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function inputHash(matrix: RgbMatrix): Promise<string> {
  return sha256Text(canonicalJson(matrix));
}

interface ImageRow {
  id: string;
  version: number;
  name: string;
  matrix: string;
  input_hash: string;
  created_at: string;
}

interface RunRow {
  id: number;
  image_id: string;
  image_version: number;
  input_hash: string;
  k: number;
  rule_version: string;
  result_json: string;
  created_at: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        matrix TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id TEXT NOT NULL,
        image_version INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        k INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(image_id, image_version, k),
        FOREIGN KEY(image_id, image_version) REFERENCES images(id, version)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async importImage(input: {
    imageId?: string;
    name?: string;
    matrix: unknown;
  }): Promise<{ imageId: string; version: number; changed: boolean }> {
    const matrix = validateMatrix(input.matrix);
    const hash = await inputHash(matrix);
    const imageId = input.imageId?.trim() || randomUUID();
    const name = input.name?.trim() || imageId;

    const latest = this.db
      .prepare(
        "SELECT * FROM images WHERE id = ? ORDER BY version DESC LIMIT 1"
      )
      .get(imageId) as ImageRow | undefined;

    if (latest && latest.input_hash === hash) {
      return { imageId, version: latest.version, changed: false };
    }

    const version = latest ? latest.version + 1 : 1;
    this.db
      .prepare(
        "INSERT INTO images(id, version, name, matrix, input_hash) VALUES (?, ?, ?, ?, ?)"
      )
      .run(imageId, version, name, JSON.stringify(matrix), hash);
    return { imageId, version, changed: true };
  }

  getImage(imageId: string, version?: number): {
    matrix: RgbMatrix;
    version: number;
    inputHash: string;
    name: string;
  } {
    const row = version
      ? (this.db
          .prepare("SELECT * FROM images WHERE id = ? AND version = ?")
          .get(imageId, version) as ImageRow | undefined)
      : (this.db
          .prepare(
            "SELECT * FROM images WHERE id = ? ORDER BY version DESC LIMIT 1"
          )
          .get(imageId) as ImageRow | undefined);

    if (!row) {
      throw new AppError("IMAGE_NOT_FOUND", "找不到指定输入图像或版本", 404, {
        imageId,
        version,
      });
    }
    return {
      matrix: JSON.parse(row.matrix) as RgbMatrix,
      version: row.version,
      inputHash: row.input_hash,
      name: row.name,
    };
  }

  listImages(): Array<{
    imageId: string;
    version: number;
    name: string;
    inputHash: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM images i
         INNER JOIN (SELECT id, MAX(version) AS version FROM images GROUP BY id) latest
         ON i.id = latest.id AND i.version = latest.version
         ORDER BY i.created_at DESC, i.id`
      )
      .all() as unknown as ImageRow[];
    return rows.map((row) => ({
      imageId: row.id,
      version: row.version,
      name: row.name,
      inputHash: row.input_hash,
      createdAt: row.created_at,
    }));
  }

  async quantizeStored(
    imageId: string,
    rawK: unknown,
    version?: number
  ): Promise<StoredResult> {
    const k = validateK(rawK);
    const image = this.getImage(imageId, version);
    const existing = this.db
      .prepare(
        "SELECT * FROM runs WHERE image_id = ? AND image_version = ? AND k = ?"
      )
      .get(imageId, image.version, k) as RunRow | undefined;
    if (existing) {
      return {
        runId: existing.id,
        k: existing.k,
        imageVersion: existing.image_version,
        ...(JSON.parse(existing.result_json) as QuantizationResult),
      };
    }

    const result = quantize(
      image.matrix,
      k,
      imageId,
      image.inputHash
    );
    const info = this.db
      .prepare(
        `INSERT INTO runs(image_id, image_version, input_hash, k, rule_version, result_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        imageId,
        image.version,
        image.inputHash,
        k,
        RULE_VERSION,
        JSON.stringify(result)
      );
    return {
      runId: Number(info.lastInsertRowid),
      k,
      imageVersion: image.version,
      ...result,
    };
  }

  async quantizeSnapshot(input: {
    name?: string;
    matrix: unknown;
    k: unknown;
  }): Promise<StoredResult> {
    const k = validateK(input.k);
    const imported = await this.importImage({
      name: input.name,
      matrix: input.matrix,
    });
    return this.quantizeStored(imported.imageId, k, imported.version);
  }

  getRun(runId: number): StoredResult {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    if (!row) {
      throw new AppError("RUN_NOT_FOUND", "找不到指定量化运行", 404, { runId });
    }
    return {
      runId: row.id,
      k: row.k,
      imageVersion: row.image_version,
      ...(JSON.parse(row.result_json) as QuantizationResult),
    };
  }

  getSteps(runId: number): SplitStep[] {
    return this.getRun(runId).steps;
  }

  getPixel(
    runId: number,
    rowIndex: unknown,
    columnIndex: unknown
  ): { row: number; column: number; original: Rgb; replacement: Rgb; paletteIndex: number } {
    if (
      !Number.isSafeInteger(rowIndex) ||
      !Number.isSafeInteger(columnIndex) ||
      (rowIndex as number) < 0 ||
      (columnIndex as number) < 0
    ) {
      throw new AppError("INVALID_COORDINATE", "行列坐标必须是整数", 400);
    }
    const normalizedRow = Number(rowIndex);
    const normalizedColumn = Number(columnIndex);
    const run = this.getRun(runId);
    const image = this.getImage(run.imageId, run.imageVersion);
    const row = run.indices[normalizedRow];
    if (!row || row[normalizedColumn] === undefined) {
      throw new AppError("PIXEL_NOT_FOUND", "像素坐标超出范围", 404, {
        row: normalizedRow,
        column: normalizedColumn,
      });
    }
    const paletteIndex = row[normalizedColumn];
    return {
      row: normalizedRow,
      column: normalizedColumn,
      original: image.matrix[normalizedRow][normalizedColumn],
      replacement: run.report.palette[paletteIndex],
      paletteIndex,
    };
  }
}
