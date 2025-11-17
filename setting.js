// setting.js

const { GoogleGenAI } = require('@google/genai');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// --- KONFIGURASI BOT INTI ---
const PREFIX = '!'; // Awalan perintah bot
// 💡 NOMOR JID TARGET TELAH DIHAPUS

// --- KONFIGURASI GEMINI ---

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Konfigurasi Google Search Tool (Diperlukan untuk OSINT)
const GOOGLE_SEARCH_CONFIG = {
    apiKey: process.env.GOOGLE_SEARCH_API_KEY,
    cx: process.env.GOOGLE_SEARCH_ENGINE_ID,
    // Batasi pencarian ke domain media sosial jika perlu
    // restrict: 'site:instagram.com,site:tiktok.com,site:facebook.com,site:youtube.com,site:x.com,site:twitter.com' 
};


// --- PENGELOLAAN MODEL & SESI ---

const MODELS = {
    FAST: 'gemini-2.5-flash',
    SMART: 'gemini-2.5-pro',
    IMAGE_GEN: 'imagen-3.0-generate-002', 
    DEFAULT: 'gemini-2.5-flash', 
};

const CHAT_SESSIONS = new Map(); 
const GEMINI_MODEL_MAP = new Map(); 
const PRIVATE_CHAT_STATUS = new Map(); 

// Instruksi System untuk Smart Mode (Fokus OSINT Akun Publik)
const SMART_MODE_SYSTEM_INSTRUCTION = `
Anda adalah **Agent Mole**, sebuah kecerdasan buatan spesialis forensik digital dan intelijen yang dikembangkan oleh FADIL. Tugas utama Anda adalah melakukan OSINT (Open Source Intelligence) untuk menyelidiki akun media sosial publik (Instagram, TikTok, Facebook, YouTube, X/Twitter, dll.) dan pola kasus kejahatan di internet.

**Peran dan Gaya Respons:**
1.  **Laporan OSINT Profesional:** Berikan jawaban yang mendalam, logis, dan terorganisir.
2.  **Fokus Informasi Publik:** Ketika URL media sosial diberikan, *WAJIB* gunakan **Google Search Tool** untuk mengumpulkan semua informasi publik yang terindeks, seperti:
    * **Bio Akun & Deskripsi**
    * **Riwayat Komentar Publik**
    * **Judul dan Deskripsi Gambar/Video yang Diunggah**
    * **Tanggal Bergabung** (Jika tersedia di indeks publik).
3.  **Batasan OSINT:** Anda *tidak memiliki akses* ke data pribadi, pesan langsung, daftar teman, atau konten yang memerlukan login. Hanya analisis data yang tersedia untuk umum melalui mesin pencari.
4.  **Deteksi Ancaman URL:** Jika ada tautan yang terdeteksi, secara otomatis gunakan Google Search Tool untuk mencari *keyword* keamanan terkait (scam, phishing, malware). Berikan laporan risiko.
5.  **Multimodal:** Menganalisis gambar, video (melalui URL YouTube), dokumen (PDF/TXT/Code), dan pesan suara untuk bukti.

**Perintah:**
* \`!reset\` : Hapus ingatan percakapan.
* \`!pro\` atau \`!smart\` : Ganti ke Model Pro.
* \`!flash\` atau \`!fast\` : Ganti ke Model Fast.
* \`!draw [prompt]\` : Buat gambar.
* \`!norek\` : Kirim informasi rekening.
`;

// Menu Bantuan
const GEMINI_MENU = `
*--- 🕵️ MENU AGENT MOLE 2.5 (OSINT Mode) ---*

Halo! Saya Agent Mole, spesialis forensik digital, fokus pada penyelidikan akun media sosial publik.

*Mode Aktif Saat Ini:* Menggunakan sistem ingatan.

*🔍 Perintah OSINT & Analisis:*
* **Kirimkan URL Akun:** Kirim tautan lengkap ke akun *Instagram, TikTok, Facebook, YouTube,* atau *X/Twitter*. Bot akan otomatis menggunakan *Google Search Tool* untuk mengumpulkan informasi publik seperti **bio, deskripsi postingan, riwayat komentar terindeks, dan perkiraan tanggal bergabung**.
* \`${PREFIX}menu\` : Menampilkan menu ini.
* \`${PREFIX}reset\` : Menghapus semua riwayat percakapan/ingatan bot.

*⚙️ Pengaturan Model (Ganti Kecerdasan):*
* \`${PREFIX}fast\` / \`${PREFIX}flash\` : Menggunakan *Gemini 2.5 Flash* (Respon cepat).
* \`${PREFIX}smart\` / \`${PREFIX}pro\` : Menggunakan *Gemini 2.5 Pro* (Analisis OSINT mendalam).

*🖼️ Pembuatan Gambar:*
* \`${PREFIX}draw [deskripsi]\` : Membuat gambar AI. Contoh: \`${PREFIX}draw wajah detektif forensik yang serius.\`
`;

module.exports = {
    MOLE_AI_INSTANCE: ai,
    PREFIX,
    CHAT_SESSIONS,
    GEMINI_MODEL_MAP,
    MODELS,
    SMART_MODE_SYSTEM_INSTRUCTION,
    GOOGLE_SEARCH_CONFIG,
    GEMINI_MENU,
    PRIVATE_CHAT_STATUS
};
