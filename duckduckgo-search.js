// duckduckgo-search.js

const { search } = require('duck-duck-scrape');

/**
 * Melakukan pencarian real-time menggunakan DuckDuckGo dan memformat hasilnya.
 * @param {string} query Teks yang akan dicari.
 * @returns {Promise<string>} Hasil pencarian yang diformat.
 */
async function duckDuckGoSearch(query) {
    console.log(`[DUCKDUCKGO RAG] Mencari data real-time untuk: "${query}"`);
    
    try {
        // Lakukan pencarian, batasi hasilnya ke 3 artikel teratas
        const { results } = await search(query, { 
            safeSearch: 'moderate',
            time: 'y', // Batasi ke tahun terakhir untuk relevansi
            maxResults: 3 
        });

        if (!results || results.length === 0) {
            return "// Tidak ada hasil DuckDuckGo yang relevan ditemukan.";
        }
        
        // Memformat hasil agar mudah dipahami oleh model Gemini
        const formattedResults = results.map((res, index) => {
            // Kita hanya ambil judul dan URL
            return `${index + 1}. [Title: ${res.title.trim()}] (Source: ${res.url})`;
        }).join('\n');

        return `
// --- DUCKDUCKGO SEARCH RESULT (RAG) ---
// Query: ${query}
${formattedResults}
// --- END RAG RESULT ---
        `.trim();

    } catch (error) {
        console.error("[DUCKDUCKGO RAG ERROR] Gagal melakukan pencarian:", error.message);
        return `// DUCKDUCKGO TOOL GAGAL: Terjadi kesalahan saat mencari data: ${error.message}`;
    }
}

module.exports = { duckDuckGoSearch };
