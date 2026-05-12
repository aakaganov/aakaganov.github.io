/**
 * Client-side book lookup via Open Library Search API (no API key).
 * @see https://openlibrary.org/dev/docs/api/search
 */

const OL_SEARCH = "https://openlibrary.org/search.json";

function normalizeTitle(raw) {
  if (Array.isArray(raw)) return String(raw[0] ?? "").trim() || "Untitled";
  return String(raw ?? "").trim() || "Untitled";
}

function pickPreferredIsbn(isbnList) {
  if (!Array.isArray(isbnList) || !isbnList.length) return "";
  const cleaned = isbnList
    .map((s) => String(s ?? "").replace(/[^0-9X]/gi, "").toUpperCase())
    .filter(Boolean);
  const isbn13 = cleaned.find((s) => /^\d{13}$/.test(s));
  if (isbn13) return isbn13;
  const isbn10 = cleaned.find((s) => /^\d{9}[\dX]$/.test(s));
  if (isbn10) return isbn10;
  return cleaned[0] ?? "";
}

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ id: string; title: string; authorsLabel: string; isbn: string; totalPages: number | null; firstYear: number | null }>>}
 */
export async function searchOpenLibraryBooks(query, signal) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const url = new URL(OL_SEARCH);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "15");

  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Open Library search failed (${res.status}). Try again in a moment.`);
  }
  const data = await res.json();
  const docs = Array.isArray(data.docs) ? data.docs : [];

  return docs.map((doc, index) => {
    const title = normalizeTitle(doc.title);
    const authors = Array.isArray(doc.author_name) ? doc.author_name.join(", ") : "";
    const isbn = pickPreferredIsbn(doc.isbn);
    const totalPages = Number.isFinite(doc.number_of_pages_median) ? doc.number_of_pages_median : null;
    const firstYear = Number.isFinite(doc.first_publish_year) ? doc.first_publish_year : null;
    return {
      id: `${title}|${isbn}|${index}`,
      title,
      authorsLabel: authors,
      isbn,
      totalPages: totalPages != null && totalPages > 0 ? totalPages : null,
      firstYear,
    };
  });
}
