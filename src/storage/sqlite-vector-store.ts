import type { Database } from 'bun:sqlite'
import type { VectorSearchResult, VectorStore } from './vector-store'
import { getExtensionPath } from '@sqliteai/sqlite-vector'

const CHUNK_TABLE = 'chunk_embeddings'
const FACT_TABLE = 'fact_embeddings'

function toVector(values: number[]): Float32Array {
  return new Float32Array(values)
}

function isAlreadyInitializedError(error: unknown): boolean {
  if (!(error instanceof Error))
    return false

  const message = error.message.toLowerCase()
  return message.includes('already initialized') || message.includes('already exists')
}

export class SqliteVectorStore implements VectorStore {
  constructor(private readonly db: Database) {}

  init(dimensions: number): void {
    const extensionPath = getExtensionPath()
    this.db.loadExtension(extensionPath)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${CHUNK_TABLE} (id INTEGER PRIMARY KEY, embedding BLOB);
      CREATE TABLE IF NOT EXISTS ${FACT_TABLE} (id INTEGER PRIMARY KEY, embedding BLOB);
    `)

    this.initializeVectorTable(CHUNK_TABLE, dimensions)
    this.initializeVectorTable(FACT_TABLE, dimensions)
  }

  upsertChunkVector(chunkId: number, embedding: number[]): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO ${CHUNK_TABLE} (id, embedding) VALUES (?, ?)`)
      .run(chunkId, toVector(embedding))
  }

  searchChunks(queryEmbedding: number[], topK: number, threshold: number): VectorSearchResult[] {
    return this.search(CHUNK_TABLE, queryEmbedding, topK, threshold)
  }

  upsertFactVector(factId: number, embedding: number[]): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO ${FACT_TABLE} (id, embedding) VALUES (?, ?)`)
      .run(factId, toVector(embedding))
  }

  deleteFactVectors(factIds: number[]): void {
    if (factIds.length === 0)
      return

    const deleteStmt = this.db.prepare(`DELETE FROM ${FACT_TABLE} WHERE id = ?`)
    for (const factId of factIds)
      deleteStmt.run(factId)
  }

  searchFacts(queryEmbedding: number[], topK: number, threshold: number): VectorSearchResult[] {
    return this.search(FACT_TABLE, queryEmbedding, topK, threshold)
  }

  // Design: Cross-group vector search + post-filter
  // The VectorStore interface is intentionally kept group-agnostic (no groupId param).
  // Instead, SqliteVectorStore provides group-scoped wrapper methods that:
  // 1. Search topK*3 candidates to compensate for cross-group dilution
  // 2. Filter results by joining with the source table's group_id column
  // This avoids modifying the VectorStore interface while ensuring group isolation.

  /**
   * Group-scoped chunk semantic search.
   * Searches with topK*3 candidates from the shared vector index,
   * then filters to only chunks belonging to the specified group.
   */
  searchChunksForGroup(
    groupId: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number,
  ): VectorSearchResult[] {
    return this.searchForGroup('chunks', CHUNK_TABLE, groupId, queryEmbedding, topK, threshold)
  }

  /**
   * Group-scoped fact semantic search.
   * Searches with topK*3 candidates from the shared vector index,
   * then filters to only facts belonging to the specified group.
   */
  searchFactsForGroup(
    groupId: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number,
  ): VectorSearchResult[] {
    return this.searchForGroup('facts', FACT_TABLE, groupId, queryEmbedding, topK, threshold)
  }

  /**
   * Shared implementation for group-scoped vector search.
   * Over-fetches candidates (topK * 3) then post-filters by group_id via JOIN
   * with the source table, returning at most topK results.
   */
  private searchForGroup(
    sourceTable: string,
    vectorTable: string,
    groupId: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number,
  ): VectorSearchResult[] {
    // Over-fetch to compensate for cross-group dilution
    const compensatedTopK = topK * 3
    const candidates = this.search(vectorTable, queryEmbedding, compensatedTopK, threshold)

    if (candidates.length === 0)
      return []

    // Filter candidates by group_id via the source table
    const placeholders = candidates.map(() => '?').join(', ')
    const matchingIds = new Set(
      (this.db.prepare(
        `SELECT id FROM ${sourceTable} WHERE id IN (${placeholders}) AND group_id = ?`,
      ).all(...candidates.map(c => c.id), groupId) as Array<{ id: number }>).map(r => r.id),
    )

    return candidates
      .filter(c => matchingIds.has(c.id))
      .slice(0, topK)
  }

  private initializeVectorTable(table: string, dimensions: number): void {
    try {
      this.db.exec(
        `SELECT vector_init('${table}', 'embedding', 'type=FLOAT32,dimension=${dimensions}')`,
      )
    }
    catch (error) {
      if (!isAlreadyInitializedError(error))
        throw error
    }
  }

  private search(
    table: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number,
  ): VectorSearchResult[] {
    if (topK <= 0)
      return []

    const rows = this.db.prepare(`
      SELECT rowid, distance
      FROM vector_full_scan('${table}', 'embedding', ?, ${Math.floor(topK)})
      ORDER BY distance
    `).all(toVector(queryEmbedding)) as Array<{ rowid: number, distance: number }>

    return rows
      .filter(row => row.distance <= threshold)
      .map(row => ({
        id: row.rowid,
        distance: row.distance,
      }))
  }
}
