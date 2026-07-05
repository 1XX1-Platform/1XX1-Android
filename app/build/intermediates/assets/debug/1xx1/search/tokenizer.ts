/**
 * 1XX1 Tokenizer
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Sorumluluk: ham metin → token listesi
 *   1. Normalize (lowercase, trim, Unicode NFKD)
 *   2. Tokenize (boşluk + ayraç ile böl)
 *   3. Stop-word filtresi
 *   4. Fuzzy eşleşme için Levenshtein mesafesi
 *
 * Bu modül yalnızca string işler. Hiçbir index veya engine bağımlılığı yok.
 * Pure functions — test edilmesi O(1).
 */

// ─── Stop-words (İngilizce + Türkçe temel) ───────────────────────────────────

const STOP_WORDS = new Set([
  // İngilizce
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "is", "are", "was", "be",
  "it", "its", "as", "into", "this", "that", "my", "i", "you",
  "we", "he", "she", "they", "all", "can", "will", "not", "do",
  "about", "up", "out", "if", "then", "so", "how", "what",
  // Türkçe
  "bir", "bu", "ve", "ile", "için", "de", "da", "ki", "ne",
  "mi", "mu", "mü", "mı", "ya", "ama", "veya", "olan", "olan",
]);

// ─── Token Tipleri ────────────────────────────────────────────────────────────

export interface TokenizeResult {
  tokens:      string[];  // filtrelenmiş, normalize edilmiş
  allTokens:   string[];  // stop-word dahil tüm tokenlar
  ngrams:      string[];  // 2-gram'lar (bileşik terimler için)
  original:    string;
  normalized:  string;
}

// ─── Normalize ───────────────────────────────────────────────────────────────

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    // Unicode NFKD: é→e, ü→u vb.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // aksan işaretlerini kaldır
    .replace(/[^\w\s\-./]/g, " ")   // harf/rakam/tire/nokta/slash hariç
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Tokenize ────────────────────────────────────────────────────────────────

const SPLIT_PATTERN = /[\s,\-_./\\|:;()[\]{}'"!?@#$%^&*+=<>~`]+/;

/**
 * Metni token'lara ayır.
 * CubePath ayıracı "/" bu aşamada split edilmez (structural query için).
 */
export function tokenize(text: string, options: {
  minLength?:    number;
  removeStops?:  boolean;
  includeNgrams?: boolean;
} = {}): TokenizeResult {
  const { minLength = 2, removeStops = true, includeNgrams = true } = options;
  const norm = normalize(text);

  const raw = norm
    .split(SPLIT_PATTERN)
    .filter((t) => t.length >= minLength);

  const allTokens = raw;

  const tokens = removeStops
    ? raw.filter((t) => !STOP_WORDS.has(t))
    : raw;

  // 2-gram'lar: ["stl", "repair"] → ["stl repair"]
  const ngrams: string[] = [];
  if (includeNgrams && tokens.length >= 2) {
    for (let i = 0; i < tokens.length - 1; i++) {
      ngrams.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }

  return { tokens, allTokens, ngrams, original: text, normalized: norm };
}

// ─── Levenshtein Mesafesi ────────────────────────────────────────────────────

/**
 * İki string arasındaki edit distance.
 * O(m×n) — pratik olarak kısa kelimeler (≤20 karakter) için kullanılır.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = 1 + Math.min(
          matrix[i - 1][j - 1],
          matrix[i - 1][j],
          matrix[i][j - 1]
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Normalize edilmiş Levenshtein benzerliği (0–1).
 * 1 = özdeş, 0 = tamamen farklı.
 */
export function similarity(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

/**
 * İki token fuzzy eşleşiyor mu?
 * threshold: minimum benzerlik (varsayılan 0.75)
 */
export function fuzzyMatch(a: string, b: string, threshold = 0.75): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 3) return false; // erken çıkış
  return similarity(a, b) >= threshold;
}

/**
 * Bir token, aday listesinden fuzzy eşleşiyor mu?
 * @returns eşleşen token ve benzerlik skoru
 */
export function findFuzzyMatch(
  token: string,
  candidates: string[],
  threshold = 0.75
): { matched: string; score: number } | null {
  let best: { matched: string; score: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    const score = similarity(token, candidate);
    if (score >= threshold && (!best || score > best.score)) {
      best = { matched: candidate, score };
    }
  }
  return best;
}
