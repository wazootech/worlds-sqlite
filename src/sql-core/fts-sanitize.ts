export const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "these",
  "those",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/**
 * sanitizeFtsQuery defends SQLite-family FTS5 engines against parsing crash
 * vectors by splitting inputs into safe token fragments (Unicode letters,
 * numbers, and combining marks — the FTS5 unicode61 tokenizer handles the
 * rest), stripping filler words, and wrapping the remaining content words in
 * explicit quotes.
 *
 * Returns an empty string when the query contains no searchable tokens
 * (e.g. pure punctuation); callers must treat that as "no keyword match"
 * rather than emitting `MATCH ""` (which crashes FTS5).
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) =>
      token
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, "")
    )
    .filter((token) => token.length > 0);

  const filteredTokens = tokens.filter((token) => !FTS_STOPWORDS.has(token));
  const normalizedTokens = filteredTokens.length > 0 ? filteredTokens : tokens;

  return normalizedTokens
    .map((token) => `"${token.replace(/"/g, "")}"`)
    .join(" ");
}
