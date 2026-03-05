/**
 * VectorStore interface for semantic search operations.
 *
 * Abstracts vector operations for chunk and fact embeddings.
 * Implementations handle vector initialization, insertion, and KNN search.
 */

export interface VectorSearchResult {
  /** Vector ID (chunk or fact ID) */
  id: number
  /** Distance from query vector (lower = more similar) */
  distance: number
}

export interface VectorStore {
  /**
   * Initialize vector tables/indexes. Called once per DB lifecycle.
   * @param dimensions - Vector dimensionality (e.g., 1536 for text-embedding-3-small)
   */
  init: (dimensions: number) => void

  /**
   * Insert or update a chunk embedding.
   * @param chunkId - Chunk ID (rowid in vector store)
   * @param embedding - Vector values
   */
  upsertChunkVector: (chunkId: number, embedding: number[]) => void

  /**
   * KNN search for similar chunks.
   * @param queryEmbedding - Query vector
   * @param topK - Maximum results to return
   * @param threshold - Distance threshold (0~2, lower = stricter)
   * @returns Results ordered by distance ascending
   */
  searchChunks: (queryEmbedding: number[], topK: number, threshold: number) => VectorSearchResult[]

  /**
   * Insert or update a fact embedding.
   * @param factId - Fact ID (rowid in vector store)
   * @param embedding - Vector values
   */
  upsertFactVector: (factId: number, embedding: number[]) => void

  /**
   * Delete fact vectors by IDs (for stale vector refresh).
   * @param factIds - Fact IDs to delete
   */
  deleteFactVectors: (factIds: number[]) => void

  /**
   * KNN search for similar facts.
   * @param queryEmbedding - Query vector
   * @param topK - Maximum results to return
   * @param threshold - Distance threshold (0~2, lower = stricter)
   * @returns Results ordered by distance ascending
   */
  searchFacts: (queryEmbedding: number[], topK: number, threshold: number) => VectorSearchResult[]
}
