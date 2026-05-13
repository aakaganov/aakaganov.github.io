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

function firstSentenceFromDoc(doc) {
  const fs = doc.first_sentence;
  if (Array.isArray(fs) && fs.length) return String(fs[0] ?? "").trim();
  if (typeof fs === "string") return fs.trim();
  return "";
}

/** Best page count from search hit (median across editions when present). */
function pagesFromSearchDoc(doc) {
  const median = doc.number_of_pages_median;
  if (Number.isFinite(median) && median > 0) return median;
  const direct = doc.number_of_pages;
  if (Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

function normalizeOlDescription(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object" && raw.value != null) return String(raw.value).trim();
  return String(raw).trim();
}

const MAX_SYNOPSIS = 1800;

/**
 * Edition lookup by ISBN — pages and description when available.
 * @param {string} isbn
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ title: string; totalPages: number | null; synopsis: string }>}
 */
export async function fetchOpenLibraryEditionByIsbn(isbn, signal) {
  const raw = String(isbn ?? "").replace(/[^0-9X]/gi, "").toUpperCase();
  const out = { title: "", totalPages: null, synopsis: "" };
  if (raw.length < 10) return out;
  const url = `https://openlibrary.org/isbn/${encodeURIComponent(raw)}.json`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) return out;
  const data = await res.json();
  if (typeof data.title === "string" && data.title.trim()) out.title = data.title.trim();
  const n = data.number_of_pages;
  if (Number.isFinite(n) && n > 0) out.totalPages = n;
  let synopsis = normalizeOlDescription(data.description);
  const workKey = Array.isArray(data.works) && data.works[0]?.key ? String(data.works[0].key) : "";
  if (!synopsis && workKey) {
    try {
      const wUrl = `https://openlibrary.org${workKey}.json`;
      const wRes = await fetch(wUrl, { signal, headers: { Accept: "application/json" } });
      if (wRes.ok) {
        const w = await wRes.json();
        synopsis = normalizeOlDescription(w.description) || synopsis;
      }
    } catch {
      /* ignore */
    }
  }
  if (synopsis.length > MAX_SYNOPSIS) synopsis = `${synopsis.slice(0, MAX_SYNOPSIS)}…`;
  out.synopsis = synopsis;
  return out;
}

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ id: string; title: string; authorsLabel: string; isbn: string; totalPages: number | null; firstYear: number | null; synopsisHint: string }>>}
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
    const totalPagesRaw = pagesFromSearchDoc(doc);
    const totalPages = totalPagesRaw != null && totalPagesRaw > 0 ? totalPagesRaw : null;
    const firstYear = Number.isFinite(doc.first_publish_year) ? doc.first_publish_year : null;
    const hint = firstSentenceFromDoc(doc);
    return {
      id: `${title}|${isbn}|${index}`,
      title,
      authorsLabel: authors,
      isbn,
      totalPages,
      firstYear,
      synopsisHint: hint,
    };
  });
}
