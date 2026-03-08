/**
 * Alias generator — uses unique-names-generator with collision handling.
 *
 * Format: `user_{adjective}_{noun}`
 * Collision: retry up to 50 times, then fallback to `user_{adj}_{noun}_{number}`
 */

import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator'

function randomName(): string {
  return `user_${uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '_',
    style: 'lowerCase',
  })}`
}

/**
 * Generate a unique user alias.
 *
 * @param existingAliases Set of already-taken aliases (for collision detection)
 * @returns Alias in format `user_{adj}_{noun}`, with numeric suffix on exhaustion
 */
export function generateAlias(existingAliases: Set<string>): string {
  // Try up to 51 times (1 initial + 50 retries) with random combinations
  for (let i = 0; i < 51; i++) {
    const candidate = randomName()
    if (!existingAliases.has(candidate)) {
      return candidate
    }
  }

  // Fallback: append incrementing number until unique
  const base = randomName()
  for (let n = 1; ; n++) {
    const fallback = `${base}_${n}`
    if (!existingAliases.has(fallback)) {
      return fallback
    }
  }
}
