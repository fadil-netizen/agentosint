// index.js

const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    downloadContentFromMessage, 
} 
= require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const setting = require('./setting'); 
const fs = require('fs'); 
const path = require('path');
// --- Pustaka Tambahan untuk QR Code ---
const Jimp = require('jimp'); 
const jsQR = require('jsqr'); 

// --- KONSTANTA BARU: Batas Ukuran File (Dua Batasan) ---
const MAX_DOC_SIZE_BYTES = 100 * 1024 * 1024;   // 100 MB untuk Dokumen
const MAX_MEDIA_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB untuk Gambar & Video
// ----------------------------------------------------


// --- KONSTANTA BARU: Pengaturan Anti-Spam & Delay (Humanisasi) ---
const ANTI_SPAM_MAP = new Map(); // Map untuk melacak waktu pesan
const SPAM_THRESHOLD = 5;       // Maks 5 pesan dalam 10 detik
const SPAM_TIME_WINDOW = 10000; // 10 detik
const RANDOM_DELAY_MIN = 1000;  // 1 detik (Delay minimum mengetik/merespon)
const RANDOM_DELAY_MAX = 5000;  // 5 detik (Delay maksimum mengetik/merespon)
const PROCESS_DELAY_MIN = 3000; // 3 detik (Waktu proses AI/Loading)
const PROCESS_DELAY_MAX = 10000; // Ditingkatkan dari 8 detik menjadi 10 detik
const API_TIMEOUT_MS = 60000; // Tambahkan timeout API 60 detik (1 menit)

// --- KONSTANTA BARU: Penjadwalan Status ---
const STATUS_REPORT_INTERVAL_MS = 2 * 60 * 1000; // 2 menit
const TARGET_JID = setting.TARGET_JID; // Diambil dari setting.js
// ------------------------------------------

// --- KONSTANTA BARU: KONFIGURASI RETRY (5x) ---
const MAX_RETRIES = 5; 
// --------------------------------------------------------------------


// --- FUNGSI BARU: Jeda Acak (Mempersonalisasi Waktu Respon) ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- FUNGSI BARU: Cek Anti-Spam ---
function checkAntiSpam(jid) {
    const now = Date.now();
    const history = ANTI_SPAM_MAP.get(jid) || [];

    // Filter pesan yang masih dalam window waktu
    const recentMessages = history.filter(time => now - time < SPAM_TIME_WINDOW);

    recentMessages.push(now);

    // Hapus pesan paling lama jika melebihi batas (agar map tidak membesar)
    while (recentMessages.length > SPAM_THRESHOLD) {
        recentMessages.shift();
    }

    ANTI_SPAM_MAP.set(jid, recentMessages);

    // Cek apakah jumlah pesan melebihi threshold
    return recentMessages.length > SPAM_THRESHOLD;
}
// ----------------------------------------------------

// --- FUNGSI BARU: Kirim Laporan Status ke Nomor Tertentu ---
async function sendStatusReport(sock, targetJid) {
    // Hanya kirim jika koneksi sudah 'open' dan bot sudah memiliki user info
    if (sock.user && sock.ws.isOpen) {
        console.log(`[STATUS REPORT] Mengirim laporan status ke ${targetJid}`);
        const now = new Date();
        const serverTime = now.toLocaleString('id-ID', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZoneName: 'short', timeZone: 'Asia/Jakarta'
        });

        const statusMessage = `
*🚨 LAPORAN STATUS AGENT MOLE 🚨*
Bot Aktif dan Terhubung ke WhatsApp.

*Waktu Laporan:* ${serverTime}
*Mode Default:* ${setting.MODELS.DEFAULT}
*Sesi Aktif:* ${setting.CHAT_SESSIONS.size} Sesi
*Status Koneksi:* ✅ Terbuka (Open)

*Instruksi:* Kirim pesan untuk melanjutkan penyelidikan.
        `.trim();

        try {
            await sock.sendPresenceUpdate('composing', targetJid); 
            await sleep(1000); 
            await sock.sendMessage(targetJid, { text: statusMessage });
            await sock.sendPresenceUpdate('available', targetJid);
        } catch (error) {
            console.error("[STATUS REPORT ERROR] Gagal mengirim pesan status:", error.message);
        }
    } else {
        console.log("[STATUS REPORT SKIP] Koneksi belum siap atau bot belum login.");
    }
}
// ----------------------------------------------------


const ai = setting.MOLE_AI_INSTANCE; 
const PREFIX = setting.PREFIX;
const CHAT_SESSIONS = setting.CHAT_SESSIONS; 
const GEMINI_MODEL_MAP = setting.GEMINI_MODEL_MAP;
const MODELS = setting.MODELS;
const SMART_MODE_SYSTEM_INSTRUCTION = setting.SMART_MODE_SYSTEM_INSTRUCTION; 
const GOOGLE_SEARCH_CONFIG = setting.GOOGLE_SEARCH_CONFIG; 
const PRIVATE_CHAT_STATUS = setting.PRIVATE_CHAT_STATUS; 


// --- FUNGSI BARU: EKSTRAKSI URL UMUM (UNTUK DETEKSI ANCAMAN) ---
function extractDangerousUrl(text) {
    // Regex yang mendeteksi http/https URL, mengabaikan wa.me/chat.whatsapp.com yang umumnya aman.
    const urlRegex = /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi;
    
    // Filter untuk mengabaikan tautan WhatsApp/YouTube/Social Media yang sudah ditangani secara spesifik
    const safeDomains = /youtube\.com|youtu\.be|instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|tiktok\.com|t\.me|wa\.me|chat\.whatsapp\.com/i;

    const matches = text.match(urlRegex) || [];
    const uniqueUrls = new Set();
    
    matches.forEach(url => {
        // Hanya tambahkan jika tidak termasuk domain yang sudah ditangani/dianggap relatif "aman"
        if (!safeDomains.test(url)) {
            uniqueUrls.add(url);
        }
    });

    return Array.from(uniqueUrls);
}
// ----------------------------------------------------


// --- FUNGSI BARU UNTUK DECODE QR CODE ---
async function decodeQrCode(buffer) {
    try {
        const image = await Jimp.read(buffer);
        const qrCode = jsQR(
            new Uint8ClampedArray(image.bitmap.data.buffer),
            image.bitmap.width,
            image.bitmap.height
        );

        if (qrCode) {
            return qrCode.data;
        } else {
            return null; 
        }
    } catch (error) {
        // console.error("Gagal mendecode QR Code, mungkin bukan QR Code:", error.message); 
        return null; // Return null jika gagal decode (error Jimp/jsQR)
    }
}


// --- FUNGSI BARU UNTUK MENGIRIM GAMBAR COMMAND (/norek) ---
async function handleSendImageCommand(sock, from, imagePath, caption) {
    try {
        // 🛡️ Humanisasi: Mulai status composing (mengetik)
        await sock.sendPresenceUpdate('composing', from); 

        if (!fs.existsSync(imagePath)) {
            await sock.sendMessage(from, { text: `⚠️ Maaf, file gambar di path \`${imagePath}\` tidak ditemukan di server.` });
            return;
        }

        const imageBuffer = fs.readFileSync(imagePath);
        
        // 🛡️ Humanisasi: Tambahkan jeda acak sebelum mengirim
        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
        await sleep(delay); 

        await sock.sendMessage(from, { 
            image: imageBuffer, 
            caption: caption || 'Informasi yang Anda minta.'
        });

    } catch (error) {
        console.error("Gagal memproses pengiriman gambar command:", error);
        await sock.sendMessage(from, { text: "Maaf, terjadi kesalahan saat mencoba mengirim gambar yang diminta." });
    } finally {
        await sock.sendPresenceUpdate('available', from); 
    }
}


// --- Fungsi Helper untuk Multimodal (Gambar, Video & Dokumen) - INLINE ---
function bufferToGenerativePart(buffer, mimeType) {
    if (!buffer || buffer.length === 0) {
        return null;
    }
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType
        },
    };
}


// --- Fungsi Helper untuk Multimodal (Gambar, Video & Dokumen) - URI (YouTube) ---
function uriToGenerativePart(uri, mimeType) {
    return {
        fileData: {
            fileUri: uri,
            mimeType: mimeType 
        },
    };
}


// --- Fungsi Helper Baru untuk Deteksi URL YouTube ---
function extractYoutubeUrl(text) {
    const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})(?:\S+)?/i;
    const match = text.match(youtubeRegex);
    
    if (match && match[0]) {
        return match[0]; 
    }
    return null;
}


// --- Fungsi Helper Baru untuk Deteksi URL Instagram ---
function extractInstagramUrl(text) {
    // Regex untuk mendeteksi URL Instagram (post, profile, reel)
    const instagramRegex = /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com)\/([\w\-\.]+)(?:\/)?(?:p|reel|tv)?\/?([\w\-\.]*)?(\/)?/i;
    const match = text.match(instagramRegex);
    
    // Kita hanya mengambil URL yang lengkap untuk analisis
    return match ? match[0] : null; 
}
// ----------------------------------------------------

// --- FUNGSI BARU: Deteksi URL X/Twitter, Facebook, TikTok ---
function extractSocialMediaUrl(text) {
    // Regex yang mencakup X/Twitter, Facebook, dan TikTok
    const socialMediaRegex = /(?:https?:\/\/(?:www\.)?)(?:twitter\.com|x\.com|facebook\.com|fb\.watch|tiktok\.com)\/([\w\-\.\/]+)/i;
    const match = text.match(socialMediaRegex);
    return match ? match[0] : null; 
}

// --- FUNGSI BARU: Deteksi ID Telegram/WhatsApp ---
function extractMessagingInfo(text) {
    // Mencari pattern username Telegram (@user) atau format link invite (t.me/joinchat)
    const telegramRegex = /(?:t\.me\/[\w\-\.]+)|(?:\@[\w\-\.]+)/i;
    // Mencari pattern link WhatsApp (wa.me/nomor) atau grup invite
    const whatsappRegex = /(?:wa\.me\/\d+)|(?:chat\.whatsapp.com\/[\w\d]+)/i;

    let info = { telegram: null, whatsapp: null };
    
    const telegramMatch = text.match(telegramRegex);
    if (telegramMatch) { info.telegram = telegramMatch[0]; }

    const whatsappMatch = text.match(whatsappRegex);
    if (whatsappMatch) { info.whatsapp = whatsappMatch[0]; }
    
    // Hanya kembalikan jika ada salah satu yang terdeteksi
    return info.telegram || info.whatsapp ? info : null;
}
// ----------------------------------------------------


/**
 * Fungsi untuk menyorot pola waktu (timestamp) di dalam teks.
 */
function highlightTimestamps(text) {
    const timestampRegex = /(\b\d{1,2}:\d{2}(:\d{2})?\b)|(\(\d{1,2}:\d{2}(:\d{2})?\))|(\[\d{1,2}:\d{2}(:\d{2})?\])/g;

    return text.replace(timestampRegex, (match) => {
        const cleanMatch = match.replace(/[\(\)\[\]]/g, '');
        return `*⏱️ \`${cleanMatch}\`*`; 
    });
}


// --- Fungsi Helper Ekstraksi Dokumen (Dibatasi ke PDF/Teks) ---
async function extractTextFromDocument(buffer, mimeType) {
    // Hanya izinkan PDF dan tipe teks/kode yang didukung native oleh Gemini.
    if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/javascript') {
        return null; // Null berarti kirim buffer langsung ke Gemini API (native support)
    }
    
    // Mengembalikan string jika tipe file tidak didukung
    return `*Dokumen Tipe Tidak Dikenal:* ${mimeType}`; 
}


// --- Fungsi Helper untuk Sesi Chat (Ingatan Otomatis & Tools) ---
function getOrCreateChat(jid, forceModel = null) {
    const selectedModel = forceModel || GEMINI_MODEL_MAP.get(jid) || MODELS.DEFAULT;
    
    // Jika tidak dipaksa modelnya, cek apakah sesi yang ada sudah menggunakan model yang benar
    if (!forceModel && CHAT_SESSIONS.has(jid)) {
        const chatInstance = CHAT_SESSIONS.get(jid);
        if (chatInstance.model !== selectedModel) {
            CHAT_SESSIONS.delete(jid); 
        } else {
             return chatInstance;
        }
    }
    
    // Jika dipaksa (untuk failover), hapus sesi lama untuk membuat yang baru dengan model berbeda
    if (forceModel && CHAT_SESSIONS.has(jid)) {
        CHAT_SESSIONS.delete(jid);
    }


    let chatConfig = {
        config: {
            // 💡 Google Search Tool AKTIF
            tools: setting.GOOGLE_SEARCH_CONFIG.apiKey && setting.GOOGLE_SEARCH_CONFIG.cx ? [{ googleSearch: setting.GOOGLE_SEARCH_CONFIG }] : [], 
            // SMART Mode System Instruction diambil dari setting.js
            ...(selectedModel === MODELS.SMART && { systemInstruction: SMART_MODE_SYSTEM_INSTRUCTION }),
             // Set Timeout untuk API Call
            timeout: API_TIMEOUT_MS,
        }
    };
    
    // 💡 Injeksi System Instruction Minimal untuk Fast Mode
    if (selectedModel === MODELS.FAST) {
         // Instruksi sederhana agar model Fast Mode (Flash) merespons sebagai Agent Mole
         chatConfig.config.systemInstruction = 'Anda adalah model bahasa besar yang digunakan untuk mencari kasus kriminal. Nama Anda adalah Agent Mole.';
    }

    const chat = ai.chats.create({ model: selectedModel, ...chatConfig });
    chat.model = selectedModel; 
    CHAT_SESSIONS.set(jid, chat);
    return chat;
}

// --- FUNGSI HELPER UNTUK CEK MENTION (FINAL) ---
function isBotMentioned(m, sock) {
    if (!sock.user) return false; 
    
    // HANYA cek mention di group
    if (!m.key.remoteJid.endsWith('@g.us')) return false; 

    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const botJidRaw = sock.user.id.split(':')[0];

    const contextInfo = m.message?.extendedTextMessage?.contextInfo;
    
    // Gunakan fungsi yang lebih robust untuk mendapatkan teks
    const messageText = extractMessageText(m); 

    const mentionedJids = contextInfo?.mentionedJid || [];
    
    // Bot ter-mention jika JID ada di daftar mention, di-reply, atau JID raw ada di teks
    return mentionedJids.includes(botJid) || 
           contextInfo?.participant === botJid || 
           messageText.includes('@' + botJidRaw);
}

// --- FUNGSI BARU: EKSTRAKSI PESAN LEBIH ROBUST ---
function extractMessageText(m) {
    // Cek pesan reguler atau pesan yang diperpanjang (extended)
    let text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    
    // Cek caption untuk media (Image, Video, Document)
    if (!text) {
        text = m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || m.message?.documentMessage?.caption || '';
    }
    
    // Cek Ephemeral Message (Pesan yang hilang)
    if (!text && m.message?.ephemeralMessage) {
        const ephemeralMsg = m.message.ephemeralMessage.message;
        text = ephemeralMsg?.conversation || 
               ephemeralMsg?.extendedTextMessage?.text ||
               ephemeralMsg?.imageMessage?.caption ||
               ephemeralMsg?.videoMessage?.caption ||
               ephemeralMsg?.documentMessage?.caption ||
               '';
    }
    
    // --- PERBAIKAN AKHIR: Menambahkan cek ViewOnceMessage (sering dikirim dari Mobile) ---
    if (m.message?.viewOnceMessage) {
        const viewMsg = m.message.viewOnceMessage.message;
        text = viewMsg?.imageMessage?.caption || 
               viewMsg?.videoMessage?.caption || 
               viewMsg?.extendedTextMessage?.text || 
               viewMsg?.documentMessage?.caption || 
               text; // Fallback ke teks yang sudah ada
    }
    // ---------------------------------------------------------------------------------

    // Cek Quoted Message (Pesan Balasan) - Seringkali masalah di Mobile
    const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage || 
                   m.message?.imageMessage?.contextInfo?.quotedMessage ||
                   m.message?.videoMessage?.contextInfo?.quotedMessage ||
                   m.message?.documentMessage?.contextInfo?.quotedMessage;
    
    // Khusus balasan, kita cek teks dari pesan yang dibalas
    // CATATAN: Kami hanya mengambil QUOTED MESSAGE TEXT jika messageText saat ini kosong
    if (!text && quoted) {
        text = quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || quoted.videoMessage?.caption || quoted.documentMessage?.caption || '';
    }

    return text.trim();
}
// --- AKHIR FUNGSI BARU ---


// --- Fungsi Utama untuk Berbicara dengan Agent Mole (Ingatan Aktif dan Multimodal) ---
async function handleGeminiRequest(sock, from, textQuery, mediaParts = [], isFailover = false) {
    let response = null;
    let lastError = null;

    // Tentukan model awal. Jika ini adalah failover, gunakan FAST mode.
    const initialModel = isFailover ? MODELS.FAST : (GEMINI_MODEL_MAP.get(from) || MODELS.DEFAULT);
    
    try {
        // 🛡️ Tahap 1: Tampilkan status ONLINE saat AI berpikir/memproses
        await sock.sendPresenceUpdate('available', from);
        
        const hasMedia = mediaParts.length > 0;
        
        console.log(`[AGENT MOLE] Memulai permintaan. Media: ${hasMedia ? mediaParts[0].inlineData?.mimeType || mediaParts[0].fileData?.mimeType : 'none'}. Mode: ${initialModel}${isFailover ? ' (FAILOVER)' : ''}`); 

        const now = new Date();
        const serverTime = now.toLocaleString('id-ID', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZoneName: 'short', timeZone: 'Asia/Jakarta'
        });

        // Hapus sesi saat ini untuk membuat sesi baru dengan model yang benar (penting untuk failover)
        const chat = getOrCreateChat(from, initialModel);
        const currentModel = chat.model;

        let contents = [...mediaParts];
        let finalQuery;
        
        const roleInjection = "Sebagai Agent Mole, seorang spesialis forensik, proses permintaan ini dan berikan respons yang profesional dan terstruktur. ";
        
        // --- DETEKSI DAN INSTRUKSI UNTUK ANCAMAN URL UMUM ---
        const dangerousUrls = extractDangerousUrl(textQuery);
        let threatInstruction = '';

        if (dangerousUrls.length > 0) {
            const urlList = dangerousUrls.map(url => `\`${url}\``).join(', ');
            
            dangerousUrls.forEach(url => {
                 textQuery = textQuery.replace(new RegExp(url.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'), '').trim();
            });

            threatInstruction = (
                `*⚠️ DETEKSI ANCAMAN URL:* Tautan potensial berbahaya terdeteksi: ${urlList}. ` +
                `*PRIORITAS*: Gunakan Tool Google Search (Web Search) untuk melakukan analisis keamanan pada setiap URL ini. Cari bukti terkait *scam*, *phishing*, *malware*, atau laporan negatif lainnya. ` +
                `Sertakan laporan risiko keamanan yang komprehensif sebagai bagian dari jawaban Anda.`
            );
        }
        // ----------------------------------------------------
        
        if (textQuery.length > 0 || threatInstruction.length > 0) {
            
            let contextInjection = `*TANGGAL/WAKTU SERVER SAAT INI:* \`${serverTime}\`. `;
            const googleSearchInstruction = "Gunakan Tool Google Search (Web Search) untuk mendapatkan informasi yang akurat, real-time, dan relevan dengan pertanyaan pengguna.";
            
            const combinedQuery = `${threatInstruction}\n\n${textQuery}`.trim();

            finalQuery = `${contextInjection}\n\n${roleInjection} ${googleSearchInstruction} *Permintaan Pengguna:*\n${combinedQuery}`;
            contents.push(finalQuery);
            
        } else if (mediaParts.length > 0) {
             const mediaPart = mediaParts[0];
             const isAudio = mediaPart.inlineData?.mimeType.startsWith('audio');
             const mediaType = isAudio ? 'voice note/audio' : (mediaPart.fileData ? 'video/URL' : (mediaPart.inlineData?.mimeType.startsWith('image') ? 'gambar' : 'dokumen'));
             
             if (isAudio) {
                 finalQuery = 
                    `${serverTime}\n\n${roleInjection}*Permintaan Audio:*\n` +
                    'Transkripsikan voice note/audio ini ke teks. *WAJIB*: Jika konten transkripsi berisi pertanyaan yang memerlukan fakta, data terbaru, atau informasi eksternal (misalnya: berita, harga, cuaca), *Gunakan Tool Google Search (Web Search)* untuk mendapatkan jawaban yang akurat. ' +
                    'Setelah itu, balaslah isi pesan tersebut dengan jawaban yang relevan dan personal. Di akhir jawaban Anda, berikan juga transkripsi dan ringkasan Voice Note sebagai referensi.';

             } else {
                 finalQuery = `${serverTime}\n\n${roleInjection}*Permintaan Analisis Media:*\nAnalisis ${mediaType} ini secara sangat mendalam dan detail.`;
             }
             contents.push(finalQuery);
        } else {
             finalQuery = 
                `${serverTime}\n\n*Pesan Default:*\nHalo! Saya Agent Mole, siap membantu analisis kasus Anda. Anda bisa mengajukan pertanyaan, mengirim gambar, video, dokumen (PDF/TXT/Code), atau *voice note* setelah me-*tag* saya. Ketik ${PREFIX}menu untuk melihat daftar perintah.`;
             contents.push(finalQuery);
        }
        
        const finalContents = mediaParts.length === 0 && contents.length === 1 ? contents[0] : contents;
        
        // --- LOGIKA RETRY DITERAPKAN DI SINI ---
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[AGENT MOLE] Mengirim pesan ke model: ${currentModel}. Percobaan ke-${attempt}/${MAX_RETRIES}`); 
                
                // Jeda Proses AI (Waktu yang Dihabiskan untuk Loading)
                const processDelay = Math.floor(Math.random() * (PROCESS_DELAY_MAX - PROCESS_DELAY_MIN + 1)) + PROCESS_DELAY_MIN;
                console.log(`[HUMANISASI] Mensimulasikan proses AI selama ${processDelay}ms... (Status: Online)`);
                await sleep(processDelay);
                
                // Kirim pesan dengan konfigurasi timeout dari objek chat
                response = await chat.sendMessage({ message: finalContents });
                
                console.log(`[AGENT MOLE] Respons diterima pada percobaan ke-${attempt}.`); 
                break; // Keluar dari loop jika berhasil

            } catch (error) {
                lastError = error;

                // Cek error 503 atau pesan yang mengindikasikan server overload/timeout
                const isRetryableError = error.status === 503 || error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('UNAVAILABLE') || error.message.includes('timeout');
                
                if (attempt < MAX_RETRIES && isRetryableError) {
                    // Exponential Backoff dengan Jitter: 2^n * 1000ms + random(1000ms)
                    const delayTime = Math.pow(2, attempt) * 1500 + Math.random() * 2000; // Meningkatkan basis delay
                    console.warn(`[RETRY WARNING] Percobaan ke-${attempt} gagal (Status ${error.status || 'Unknown'}). Mencoba lagi dalam ${Math.round(delayTime / 1000)} detik.`);
                    await sleep(delayTime);
                } else if (isRetryableError && !isFailover && currentModel === MODELS.SMART) {
                     // Ini adalah kegagalan 503 final pada Smart Mode, lakukan Failover.
                     console.warn(`[FAILOVER] Smart Mode gagal setelah ${MAX_RETRIES} percobaan. Mencoba sekali di Fast Mode.`);
                     
                     // Panggil fungsi ini sendiri untuk melakukan 1x percobaan Fast Mode
                     await handleGeminiRequest(sock, from, textQuery, mediaParts, true); 
                     return; // Keluar dari fungsi utama, respons akan ditangani oleh panggilan failover

                } else if (isRetryableError) {
                     // Ini adalah kegagalan 503 final (atau kegagalan failover)
                     console.error(`[FATAL ERROR 503] Semua ${MAX_RETRIES} percobaan gagal.`, error.message);
                     throw new Error("Model terlalu sibuk (503). Mohon coba lagi nanti.");
                } else {
                    // Ini adalah error non-retryable (400, 429, dll.)
                    throw error;
                }
            }
        }
        
        if (!response) {
            throw lastError; 
        }

        let geminiResponse = response.text.trim();
        
        const isYoutubeAnalysis = mediaParts.some(part => part.fileData && part.fileData.mimeType === 'video/youtube');
        
        if (isYoutubeAnalysis) {
             geminiResponse = highlightTimestamps(geminiResponse);
        }
        
        let modelStatus;
        if (currentModel === MODELS.FAST) {
            modelStatus = 'Mole 2.5-flash';
            
            if (geminiResponse.includes('Saya adalah model bahasa besar') || geminiResponse.includes('I am a large language model')) {
                geminiResponse = 'Saya adalah Agent Mole, model bahasa besar yang digunakan untuk mencari kasus kriminal.';
            }

        } else if (currentModel === MODELS.SMART) {
            modelStatus = 'Agent Mole (2.5-pro)';
        } else {
            modelStatus = currentModel;
        }

        let finalResponse =`*💠 Mode Aktif:* \`${modelStatus}\`\n${geminiResponse}`;

        if (isFailover) {
            finalResponse = `⚠️ *Mode Failover (503 Error)*: Server Smart Mode sedang sibuk. Kami menurunkan mode ke Fast Mode (Mole 2.5-flash) untuk menyelesaikan permintaan Anda.\n\n` + finalResponse;
        }

        // 🛡️ Tahap 2: Tampilkan status COMPOSING (mengetik) sebelum mengirim pesan
        await sock.sendPresenceUpdate('composing', from); 
        const typingDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
        console.log(`[HUMANISASI] Menunda respons selama ${typingDelay}ms sambil mengetik...`);
        await sleep(typingDelay); 

        await sock.sendMessage(from, { text: finalResponse });
        
        // --- OPTIMASI EFISIENSI MEMORI ---
        // Jika mode bukan failover, perbarui status model pengguna
        if (!isFailover) {
            if (hasMedia) {
                 const history = await chat.getHistory();
                 CHAT_SESSIONS.delete(from);
                 const newChat = getOrCreateChat(from);
                 
                 const textOnlyHistory = history.filter(msg => {
                     return typeof msg.parts[0] === 'string' || (msg.parts.length === 1 && typeof msg.parts[0].text === 'string');
                 });
                 
                 const smallTextHistory = textOnlyHistory.slice(-3);
                 newChat.history = smallTextHistory;
                 
                 console.log(`[OPTIMASI MEMORI] Sesi dengan media dihapus. Sesi baru dibuat dengan ${smallTextHistory.length} riwayat teks.`);
            }
        } else {
             // Jika failover berhasil, sesi Fast Mode tetap ada, dan kita HANYA perlu menghapus histori jika ada media
             if (hasMedia) {
                 CHAT_SESSIONS.delete(from);
                 getOrCreateChat(from, MODELS.FAST); // Buat ulang sesi fast mode tanpa history media
             }
             // *PENTING*: Jangan ubah GEMINI_MODEL_MAP pengguna; biarkan mereka tetap di SMART mode untuk permintaan berikutnya.
        }
        // ------------------------------------------------------------------

    } catch (error) {
        console.error("-----------------------------------------------------");
        console.error("🚨 GAGAL MEMPROSES PERMINTAAN AGENT MOLE:", error); 
        console.error("-----------------------------------------------------");
        
        let errorDetail = "Terjadi kesalahan koneksi atau pemrosesan umum.";
        
        if (error.message.includes('file is not supported') || error.message.includes('Unsupported mime type')) {
            errorDetail = "Tipe file media/audio tidak didukung oleh Agent Mole. Pastikan format file audio adalah MP3, WAV, atau format umum lainnya."; 
        } else if (error.message.includes('400')) {
             errorDetail = "Ukuran file terlalu besar atau kunci API bermasalah. (Error 400 Bad Request)";
        } else if (error.message.includes('500')) {
             errorDetail = "Agent Mole AI mengalami error internal. Coba lagi sebentar."; 
        } else if (error.message.includes('Model terlalu sibuk')) {
             errorDetail = "Server AI sedang kelebihan beban. Kami sudah mencoba 5x. Mohon tunggu 5-10 menit dan coba lagi.";
        }
        
        await sock.sendPresenceUpdate('composing', from);
        const typingDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
        await sleep(typingDelay);

        await sock.sendMessage(from, { text: `Maaf, terjadi kesalahan saat menghubungi Agent Mole.\n\n⚠️ *Detail Error:* ${errorDetail}` });
    } finally {
        await sock.sendPresenceUpdate('available', from); 
    }
}


// --- Fungsi Khusus untuk Image Generation ---
async function handleImageGeneration(sock, from, prompt) {
    let response = null;
    let lastError = null;

    try {
        await sock.sendPresenceUpdate('composing', from); 

        const model = MODELS.IMAGE_GEN; 

        console.log(`[AGENT MOLE DRAW] Menerima permintaan: "${prompt}"`); 
        
        // --- LOGIKA RETRY DITERAPKAN DI SINI ---
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[AGENT MOLE DRAW] Mengirim permintaan. Percobaan ke-${attempt}/${MAX_RETRIES}`); 

                // Jeda Proses AI sebelum pemanggilan API
                const processDelay = Math.floor(Math.random() * (PROCESS_DELAY_MAX - PROCESS_DELAY_MIN + 1)) + PROCESS_DELAY_MIN;
                await sleep(processDelay);
                
                // Tambahkan config timeout 
                const imageConfig = {
                    model: model,
                    contents: [prompt],
                    config: {
                        timeout: API_TIMEOUT_MS,
                    }
                };

                response = await ai.models.generateContent(imageConfig);
                
                console.log(`[AGENT MOLE DRAW] Respons diterima pada percobaan ke-${attempt}.`); 
                break; // Keluar dari loop jika berhasil
            } catch (error) {
                lastError = error;

                // Cek error 503 atau pesan yang mengindikasikan server overload/timeout
                const isRetryableError = error.status === 503 || error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('UNAVAILABLE') || error.message.includes('timeout');

                if (attempt < MAX_RETRIES && isRetryableError) {
                    // Exponential Backoff dengan Jitter: 2^n * 1000ms + random(1000ms)
                    const delayTime = Math.pow(2, attempt) * 1500 + Math.random() * 2000; 
                    console.warn(`[RETRY WARNING DRAW] Percobaan ke-${attempt} gagal (Status ${error.status || 'Unknown'}). Mencoba lagi dalam ${Math.round(delayTime / 1000)} detik.`);
                    await sleep(delayTime);
                } else if (isRetryableError) {
                    console.error(`[FATAL ERROR 503 DRAW] Semua ${MAX_RETRIES} percobaan gagal.`, error.message);
                    throw new Error("Model gambar terlalu sibuk (503). Mohon coba lagi nanti.");
                } else {
                    // Error non-retryable
                    throw error;
                }
            }
        }

        if (!response) {
             throw lastError;
        }

        const imagePart = response.candidates?.[0]?.content?.parts?.find(
            part => part.inlineData && part.inlineData.mimeType.startsWith('image/')
        );
        
        if (imagePart) {
            const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
            
            // 🛡️ Humanisasi: Jeda sebelum mengirim pesan gambar (typing)
            await sock.sendPresenceUpdate('composing', from); 
            const typingDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
            await sleep(typingDelay); 

            await sock.sendMessage(from, { 
                image: imageBuffer, 
                caption: `✅ *Gambar Dibuat (Model: \`${model}\`):*\n"${prompt}"`
            });

        } else {
            // 🛡️ Humanisasi: Jeda sebelum mengirim pesan error (typing)
            await sock.sendPresenceUpdate('composing', from);
            const typingDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
            await sleep(typingDelay); 
            
            console.error("[AGENT MOLE DRAW ERROR] Respon tidak mengandung gambar. Respon teks:", response.text); 
            await sock.sendMessage(from, { text: `Maaf, gagal membuat gambar untuk prompt: "${prompt}". Model hanya mengembalikan teks:\n${response.text}` });
        }

    } catch (error) {
        console.error("-----------------------------------------------------");
        console.error("🚨 GAGAL MEMPROSES IMAGE GENERATION:", error.message);
        console.error("-----------------------------------------------------");

        let errorDetail = "Terjadi kesalahan saat mencoba membuat gambar.";
        if (error.message.includes("Model gambar terlalu sibuk")) {
             errorDetail = "Server AI Image Generator sedang kelebihan beban. Kami sudah mencoba 5x. Mohon tunggu 5-10 menit dan coba lagi.";
        }
        
        // 🛡️ Humanisasi: Jeda sebelum kirim pesan error (typing)
        await sock.sendPresenceUpdate('composing', from);
        const typingDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
        await sleep(typingDelay);

        await sock.sendMessage(from, { 
            text: `Maaf, terjadi kesalahan saat mencoba membuat gambar dengan Agent Mole.\n\n⚠️ *Detail Error:* ${errorDetail}` 
        });
    } finally {
        await sock.sendPresenceUpdate('available', from); 
    }
}


// --- Fungsi Pengelolaan Perintah ---
async function resetUserMemory(sock, jid) {
    CHAT_SESSIONS.delete(jid);
    
    // 🛡️ Humanisasi: Kirim status typing dan jeda
    await sock.sendPresenceUpdate('composing', jid);
    const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
    await sleep(delay); 
    
    await sock.sendMessage(jid, { text: '*✅ Semua ingatan riwayat percakapan Anda telah dihapus*. Ingatan telah dimatikan.' });
    await sock.sendPresenceUpdate('available', jid); // PENTING: Kembalikan status
}


async function changeModel(sock, jid, modelKey) {
    const newModel = MODELS[modelKey];
    const newModelName = modelKey === 'FAST' ? 'Fast Mode' : 'Smart Mode';
    
    GEMINI_MODEL_MAP.set(jid, newModel);
    CHAT_SESSIONS.delete(jid); 

    // 🛡️ Humanisasi: Kirim status typing dan jeda
    await sock.sendPresenceUpdate('composing', jid);
    const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
    await sleep(delay); 

    await sock.sendMessage(jid, { text: `✅ Mode telah diganti menjadi *${newModelName}* (\`${newModel}\`). Ingatan baru akan dimulai.` });
    await sock.sendPresenceUpdate('available', jid); // PENTING: Kembalikan status
}


// Fungsi utama untuk menjalankan bot
async function startSock() {
    try {
        // --- FOKUS UTAMA: useMultiFileAuthState('baileys_auth_info') ---
        // Jika folder 'baileys_auth_info' tidak ada, Baileys akan memulai sesi baru.
        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info'); 
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Disetel false karena kita tangani QR di event listener
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // ✅ LOGIKA QR CODE BARU: Dipanggil jika tidak ada sesi tersimpan
                qrcode.generate(qr, { small: true });
                console.log("Scan QR code ini dengan WhatsApp kamu!");
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error) ? 
                    (new Boom(lastDisconnect.error)).output.statusCode !== DisconnectReason.loggedOut :
                    true; 

                if (shouldReconnect) {
                    console.log('Koneksi tertutup, mencoba menyambung ulang secara otomatis...');
                    // Jeda sebentar sebelum mencoba menyambung ulang
                    setTimeout(() => startSock(), 3000); 
                } else {
                    console.log('Koneksi ditutup. Anda telah logout (Sesi dihapus).');
                    // ⚠️ CATATAN PENTING: Jika terjadi DisconnectReason.loggedOut, 
                    // Anda harus HAPUS folder 'baileys_auth_info' secara manual sebelum menjalankan bot lagi.
                }
            } else if (connection === 'open') {
                console.log('Bot siap digunakan! Agent Mole Aktif.');
                
                // 💡 LOGIKA PENJADWALAN STATUS AKTIF DI SINI
                // Kirim laporan status pertama kali saat koneksi terbuka
                sendStatusReport(sock, TARGET_JID); 
                
                // Jadwalkan laporan status berulang setiap 2 menit (STATUS_REPORT_INTERVAL_MS)
                setInterval(() => {
                    sendStatusReport(sock, TARGET_JID);
                }, STATUS_REPORT_INTERVAL_MS);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Event listener untuk pesan masuk DIBUNGKUS DENGAN TRY-CATCH UNTUK STABILITAS
        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const m = messages[0];
                if (!m.message || m.key.fromMe) return; 

                const from = m.key.remoteJid;
                const isGroup = from.endsWith('@g.us');

                // 🛡️ STRATEGI ANTI-SPAM: Cek dan abaikan jika melebihi batas
                if (checkAntiSpam(from)) {
                    // Hanya di chat pribadi, beri peringatan sekali, lalu diam.
                    if (!isGroup && ANTI_SPAM_MAP.get(from).length === SPAM_THRESHOLD + 1) {
                         // 🛡️ Humanisasi: Jeda sebelum kirim peringatan
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay);
                        
                        // Kirim peringatan hanya sekali saat batas dilanggar
                        await sock.sendMessage(from, { text: "⚠️ *Peringatan Anti-Spam*: Anda mengirim terlalu banyak pesan dalam waktu singkat. Mohon tunggu sebentar sebelum mengirim lagi." });
                    }
                    console.log(`[ANTI-SPAM] Mengabaikan pesan dari JID: ${from}`);
                    await sock.sendPresenceUpdate('available', from);
                    return; 
                }
                // ---------------------------------------------------------
                
                const messageType = Object.keys(m.message)[0];
                // --- AMBIL TEKS MENGGUNAKAN FUNGSI ROBUST ---
                let messageText = extractMessageText(m); 
                // ------------------------------------------
                
                const command = messageText.toLowerCase().split(' ')[0];
                const args = messageText.slice(command.length).trim();
                const rawText = messageText.trim(); // Untuk pengecekan 1/2

                // --- LOGIKA PESAN SELAMAT DATANG / SESSION LOCK (Pribadi) ---
                if (!isGroup) {
                    const currentStatus = PRIVATE_CHAT_STATUS.get(from);
                    
                    // Logika Sambutan Pertama Kali
                    if (!PRIVATE_CHAT_STATUS.has(from) && !CHAT_SESSIONS.has(from) && rawText.length > 0 && !rawText.startsWith(PREFIX)) {
                        
                        const welcomeMessage = `
Halo anda telah menghubungi salah satu Agent(fadil), silahkan tunggu sistem terhubung dengan agent atau.

    Ketik: \`2\`
    untuk memulai percakapan dengan Agent Mole.
    *jika anda berada di percakapan Agent Mole*
    Ketik: \`1\`
    (untuk keluar dari percakapan Agent Mole dan kembali menghubungi nomor ini).

*Petunjuk Singkat:*
Tips💡
Chat Mole adalah chat AI Agent dirancang untuk menyelidiki pola kasus kejahatan di internet 
dan terhubung dengan darkweb dan internet untuk pencarian .
- Untuk bertanya/kirim media dengan Agent Mole, aktifkan sesi dengan mengetik \`2\` terlebih dahulu.
- Ketik \`${PREFIX}menu\` untuk melihat daftar perintah lengkap.
                        `.trim();

                        // 🛡️ Humanisasi: Kirim status typing dan jeda
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay); 

                        await sock.sendMessage(from, { text: welcomeMessage });
                        PRIVATE_CHAT_STATUS.set(from, false); 
                        await sock.sendPresenceUpdate('available', from);
                        return;
                    }

                    // Logika Session Lock
                    if (rawText === '2') {
                        PRIVATE_CHAT_STATUS.set(from, true);
                         // 🛡️ Humanisasi: Kirim status typing dan jeda
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay); 
                        await sock.sendMessage(from, { text: `✅ *Sesi Chatbot Agent Mole telah diaktifkan!* Anda sekarang bisa langsung bertanya, kirim media, atau URL. Ketik \`1\` untuk keluar dari sesi.` });
                        await sock.sendPresenceUpdate('available', from);
                        return; 
                    }
                    if (rawText === '1') {
                        PRIVATE_CHAT_STATUS.set(from, false);
                        CHAT_SESSIONS.delete(from); 
                        // 🛡️ Humanisasi: Kirim status typing dan jeda
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay); 
                        await sock.sendMessage(from, { text: `❌ *Sesi Chatbot Agent Mole telah dinonaktifkan!* Bot akan diam. Ketik \`2\` untuk mengaktifkan sesi lagi.` });
                        await sock.sendPresenceUpdate('available', from);
                        return;
                    }
                    
                    // Abaikan jika status non-aktif dan bukan command, dan bukan media/url
                    const isMediaMessage = messageType !== 'conversation' && messageType !== 'extendedTextMessage';
                    
                    // Pengecekan URL yang lebih luas
                    const isUrl = rawText.match(/(https?:\/\/(?:www\.)?youtube\.com|youtu\.be|instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|tiktok\.com|t\.me|wa\.me|chat\.whatsapp\.com)/i);

                    
                    if (currentStatus === false && !messageText.toLowerCase().startsWith(PREFIX) && !isMediaMessage && !isUrl) {
                        return; 
                    }
                }
                
                // --- Penanganan Perintah Khusus (Command Logic) ---
                
                if (command === `${PREFIX}norek`) {
                    const imagePath = path.join(__dirname, 'assets', 'norek_info.png'); 
                    // 🛡️ STRATEGI ANTI-SPAM: Modifikasi caption agar tidak statis/spammy
                    const caption = `*💸 Info Rekening (PENTING):*\n\nInformasi ini untuk transfer dana yang aman. Pastikan nama penerima sudah benar.\n\nBerikut adalah detail dan QR Code untuk mempermudah transaksi. Terima kasih.`;
                    await handleSendImageCommand(sock, from, imagePath, caption);
                    return;
                }
                if (command === `${PREFIX}menu`) {
                    // 🛡️ Humanisasi: Kirim status typing dan jeda
                    await sock.sendPresenceUpdate('composing', from);
                    const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                    await sleep(delay); 
                    
                    await sock.sendMessage(from, { text: setting.GEMINI_MENU });
                    await sock.sendPresenceUpdate('available', from);
                    return;
                }
                if (command === `${PREFIX}reset`) {
                    await resetUserMemory(sock, from);
                    return;
                }
                if (command === `${PREFIX}flash` || command === `${PREFIX}fast`) {
                    await changeModel(sock, from, 'FAST');
                    return;
                }
                if (command === `${PREFIX}pro` || command === `${PREFIX}smart`) {
                    await changeModel(sock, from, 'SMART');
                    return;
                }
                if (command === `${PREFIX}draw` || command === `${PREFIX}gambar`) {
                    if (args.length > 0) {
                        await handleImageGeneration(sock, from, args);
                    } else {
                        // 🛡️ Humanisasi: Kirim status typing dan jeda
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay);
                        
                        await sock.sendMessage(from, { text: "Mohon berikan deskripsi gambar yang ingin Anda buat, contoh: `"+ PREFIX +"draw seekor anjing detektif mengenakan topi fedora, gaya noir`" });
                        await sock.sendPresenceUpdate('available', from);
                    }
                    return;
                }
                
                // ----------------------------------------------------------------------
                // --- LOGIKA PEMROSESAN QUERY (FINAL) ---
                // ----------------------------------------------------------------------
                
                let queryText = messageText;
                let mediaParts = [];
                let isGeminiQuery = false;
                let documentExtractedText = null; 

                // A. LOGIKA UTAMA PENENTUAN APakah BOT HARUS MERESPONS 
                const isMentionedInGroup = isGroup && isBotMentioned(m, sock);
                const isSessionActiveInPrivate = !isGroup && PRIVATE_CHAT_STATUS.get(from) === true;
                
                // Set isGeminiQuery: Bot merespons jika:
                // 1. Di grup DAN di-mention.
                // 2. Di chat pribadi DAN sesi aktif.
                if (isMentionedInGroup || isSessionActiveInPrivate) {
                    isGeminiQuery = true;
                } else if (isGroup) {
                    return; // Di grup dan tidak di-mention, abaikan
                }

                if (isMentionedInGroup) {
                    // --- LOGIKA PENGHAPUSAN MENTION ---
                    const botJidRaw = sock.user?.id?.split(':')[0]; 
                    if (botJidRaw) {
                        // Regex untuk menghapus @[nomorbot] di mana pun dalam teks
                        const mentionRegex = new RegExp(`@${botJidRaw}`, 'g');
                        queryText = queryText.replace(mentionRegex, '').trim();
                    }
                } 
                
                // Helper untuk download dan pengecekan ukuran media
                const downloadAndCheckSize = async (msg, type) => {
                    // Menggunakan fileLength yang aman (bisa null/undefined)
                    const fileSize = msg.fileLength ? Number(msg.fileLength) : 0;
                    const maxSize = type === 'document' ? MAX_DOC_SIZE_BYTES : MAX_MEDIA_SIZE_BYTES;

                    if (fileSize > maxSize) {
                        await sock.sendMessage(from, { text: `⚠️ Maaf, ukuran file (${type}) melebihi batas maksimum *${(maxSize / 1024 / 1024).toFixed(0)} MB*.` });
                        return null;
                    }
                    // Hanya tampilkan 'composing' saat download, bukan saat AI berpikir.
                    await sock.sendPresenceUpdate('composing', from); 
                    const stream = await downloadContentFromMessage(msg, type);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    return buffer;
                };
                
                // A1. Pesan Gambar Langsung atau Balasan Gambar
                if (messageType === 'imageMessage' || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                    isGeminiQuery = true; // Set query flag jika ada media
                    const imageMsg = messageType === 'imageMessage' ? m.message.imageMessage : m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                    const buffer = await downloadAndCheckSize(imageMsg, 'image');

                    if (!buffer) { await sock.sendPresenceUpdate('available', from); return; }
                    
                    const qrData = await decodeQrCode(buffer);
                    if (qrData) {
                        // 🛡️ Humanisasi: Kirim status typing dan jeda untuk respons QR
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay); 
                        
                        await sock.sendMessage(from, { text: `*✅ QR Code Ditemukan!*:\n\`\`\`\n${qrData}\n\`\`\`` });
                        await sock.sendPresenceUpdate('available', from); // Kembali ke available setelah pesan info QR
                        
                        const qrPrompt = `QR Code di gambar ini berisi data: "${qrData}". Analisis data QR Code ini dan juga gambar keseluruhan, lalu balas pesan ini.`;
                        queryText = queryText.length > 0 ? `${qrPrompt}\n\n*Instruksi Pengguna Tambahan:*\n${queryText}` : qrPrompt;
                    }
                    
                    mediaParts.push(bufferToGenerativePart(buffer, imageMsg.mimetype));
                }
                
                // A2. Pesan Video Langsung atau Balasan Video
                else if (messageType === 'videoMessage' || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage) {
                    isGeminiQuery = true; // Set query flag jika ada media
                    const videoMsg = messageType === 'videoMessage' ? m.message.videoMessage : m.message.extendedTextMessage.contextInfo.quotedMessage.videoMessage;
                    const buffer = await downloadAndCheckSize(videoMsg, 'video');
                    
                    if (!buffer) { await sock.sendPresenceUpdate('available', from); return; }
                    
                    console.log(`[VIDEO] Menerima video: ${videoMsg.mimetype, videoMsg.fileLength} bytes`);
                    mediaParts.push(bufferToGenerativePart(buffer, videoMsg.mimetype));
                }
                
                // B. Pemrosesan Dokumen (HANYA PDF/Teks)
                else if (messageType === 'documentMessage' || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage) {
                    const documentMsg = messageType === 'documentMessage' 
                        ? m.message.documentMessage 
                        : m.message.extendedTextMessage.contextInfo.quotedMessage.documentMessage;

                    const mimeType = documentMsg.mimetype;
                    
                    if (documentMsg.fileLength > MAX_DOC_SIZE_BYTES) {
                        await sock.sendMessage(from, { text: `⚠️ Maaf, ukuran dokumen melebihi batas maksimum *${(MAX_DOC_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB*.` });
                        await sock.sendPresenceUpdate('available', from);
                        return;
                    }

                    // List mime types yang didukung: HANYA PDF, dan tipe teks/kode lain (yang didukung native oleh Gemini API)
                    const isSupported = mimeType.includes('pdf') || mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('javascript');

                    if (isSupported) {
                        isGeminiQuery = true; // Set query flag jika ada media/dokumen
                        await sock.sendPresenceUpdate('composing', from); 

                        const stream = await downloadContentFromMessage(documentMsg, 'document');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        
                        documentExtractedText = await extractTextFromDocument(buffer, mimeType);
                        
                        if (!documentExtractedText) {
                            // Jika null, kirim buffer langsung ke Gemini (untuk PDF, TXT, dll.)
                            mediaParts.push(bufferToGenerativePart(buffer, mimeType));
                            console.log(`[AGENT MOLE API] File ${mimeType} dikirim langsung ke Agent Mole AI.`); 
                        } else {
                            // Jika mengembalikan string (yang berarti tipe file tidak didukung)
                            await sock.sendPresenceUpdate('composing', from);
                            const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                            await sleep(delay);

                            await sock.sendMessage(from, { text: `⚠️ Maaf, tipe file dokumen \`${mimeType}\` belum didukung. Agent Mole hanya mendukung *PDF, TXT, dan tipe file kode/teks* lainnya.` });
                            await sock.sendPresenceUpdate('available', from);
                            return;
                        }

                    } else {
                        // 🛡️ Humanisasi: Jeda sebelum kirim pesan error
                        await sock.sendPresenceUpdate('composing', from);
                        const delay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN + 1)) + RANDOM_DELAY_MIN;
                        await sleep(delay);

                        await sock.sendMessage(from, { text: `⚠️ Maaf, tipe file dokumen \`${mimeType}\` belum didukung. Agent Mole hanya mendukung *PDF, TXT, dan tipe file kode/teks* lainnya.` });
                        await sock.sendPresenceUpdate('available', from);
                        return;
                    }
                }
                
                // C. Deteksi Voice Note/Audio (AKTIF)
                else if (messageType === 'audioMessage' || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage) {
                    const audioMsg = messageType === 'audioMessage' 
                        ? m.message.audioMessage 
                        : m.message.extendedTextMessage.contextInfo.quotedMessage.audioMessage;
                    
                    if (audioMsg.mimetype.includes('audio')) {
                        isGeminiQuery = true; // Set query flag jika ada media
                        const buffer = await downloadAndCheckSize(audioMsg, 'audio');
                        
                        if (!buffer) { await sock.sendPresenceUpdate('available', from); return; }
                        
                        console.log(`[AUDIO ANALYZER] Menerima Voice Note: ${audioMsg.mimetype}, ukuran: ${buffer.length} bytes`);
                        
                        mediaParts.push(bufferToGenerativePart(buffer, audioMsg.mimetype));
                        
                        // Prompt Interaktif Default untuk Audio (Hanya diterapkan jika query teks kosong)
                        if (queryText.length === 0) {
                            // *** MODIFIKASI PROMPT EKSPLISIT ***
                            queryText = (
                                'Transkripsikan voice note/audio ini ke teks. *WAJIB*: Jika konten transkripsi berisi pertanyaan yang memerlukan fakta, data terbaru, atau informasi eksternal (misalnya: berita, harga, cuaca), *Gunakan Tool Google Search (Web Search)* untuk mendapatkan jawaban yang akurat. ' +
                                'Setelah itu, balaslah isi pesan tersebut dengan jawaban yang relevan dan personal. Di akhir jawaban Anda, berikan juga transkripsi dan ringkasan Voice Note sebagai referensi.'
                            );
                            // ***************************************************************
                        }
                    }
                }
                
                // D1. Deteksi URL YouTube 
                const youtubeUrl = extractYoutubeUrl(queryText);
                let youtubePart = null;
                
                if (youtubeUrl) {
                    isGeminiQuery = true; // Set query flag jika ada URL
                    youtubePart = uriToGenerativePart(youtubeUrl, 'video/youtube'); 
                    mediaParts.push(youtubePart);
                    queryText = queryText.replace(youtubeUrl, '').trim(); 
                }

                // D2. Deteksi URL Instagram 
                const instagramUrl = extractInstagramUrl(queryText);

                if (instagramUrl) {
                    isGeminiQuery = true;
                    // Hapus URL dari query teks agar tidak redundan
                    queryText = queryText.replace(instagramUrl, '').trim(); 
                    
                    // SUNATKAN INSTRUKSI KHUSUS
                    const instagramInstruction = (
                         `*ANALISIS SOSIAL MEDIA - INSTAGRAM:* URL Instagram terdeteksi: \`${instagramUrl}\`. ` +
                         `Gunakan Tool Google Search (Web Search) untuk mengidentifikasi konten publik yang terkait dengan URL ini dan subjeknya. ` +
                         `Lakukan analisis ancaman profil/konten berdasarkan URL ini dan semua informasi yang berhasil Anda temukan. ` +
                         `*PERHATIAN*: Anda tidak memiliki akses ke konten pribadi atau login Instagram. Fokus pada informasi publik yang terindeks.`
                    );
                    
                    // Gabungkan instruksi baru dengan query yang tersisa
                    queryText = queryText.length > 0 ? `${instagramInstruction}\n\n*Permintaan Pengguna:*\n${queryText}` : instagramInstruction;
                }
                
                // E. Deteksi URL X (Twitter), Facebook, dan TikTok BARU
                const otherSocialUrl = extractSocialMediaUrl(queryText);
                const messagingInfo = extractMessagingInfo(queryText);
                let socialMediaInstruction = null;

                if (otherSocialUrl) {
                    isGeminiQuery = true;
                    queryText = queryText.replace(otherSocialUrl, '').trim(); 
                    
                    socialMediaInstruction = (
                         `*ANALISIS SOSIAL MEDIA - TERDETEKSI:* URL ${otherSocialUrl.includes('facebook') ? 'Facebook' : (otherSocialUrl.includes('x.com') || otherSocialUrl.includes('twitter.com') ? 'X/Twitter' : 'TikTok')} terdeteksi: \`${otherSocialUrl}\`. ` +
                         `Gunakan Tool Google Search (Web Search) untuk mengidentifikasi konten publik yang terkait dengan URL ini dan subjeknya. ` +
                         `Lakukan analisis ancaman profil/konten berdasarkan URL ini dan semua informasi publik yang berhasil Anda temukan. ` +
                         `*PERHATIAN*: Anda tidak boleh mencoba akses login atau konten pribadi. Fokus pada informasi publik yang terindeks.`
                    );
                } 
                else if (messagingInfo) {
                    isGeminiQuery = true;
                    // Hapus info Telegram/WhatsApp dari query teks
                    queryText = queryText.replace(messagingInfo.telegram || '', '').replace(messagingInfo.whatsapp || '', '').trim();
                    
                    let platform = messagingInfo.telegram ? 'Telegram' : 'WhatsApp';
                    let infoData = messagingInfo.telegram || messagingInfo.whatsapp;
                    
                    socialMediaInstruction = (
                         `*ANALISIS PLATFORM CHAT - TERDETEKSI:* Informasi ${platform} terdeteksi: \`${infoData}\`. ` +
                         `Gunakan Tool Google Search (Web Search) untuk mencari tautan grup, username, atau informasi publik yang terkait dengan data ini. ` +
                         `Berikan analisis risiko keamanan atau potensi ancaman yang terkait. ` +
                         `*PERHATIAN*: Bot tidak dapat mengakses pesan pribadi. Fokus pada informasi yang tersedia di indeks publik.`
                    );
                }

                // F. Gabungkan Instruksi Sosial Media (BARU)
                if (socialMediaInstruction) {
                    queryText = queryText.length > 0 ? `${socialMediaInstruction}\n\n*Permintaan Pengguna:*\n${queryText}` : socialMediaInstruction;
                }
                
                // G. Perintah Teks dan Gabungkan Query
                if (documentExtractedText) {
                    queryText = `${documentExtractedText}\n\n*Permintaan Analisis Pengguna:*\n${queryText.length > 0 ? queryText : 'Mohon analisis dokumen ini.'}`;
                } else if (youtubePart && queryText.length === 0) {
                    queryText = 'Mohon berikan ringkasan yang detail dan analisis mendalam dari video YouTube ini. Sertakan poin-pun penting dan kesimpulan.';
                } else if (mediaParts.length > 0 && queryText.length === 0) {
                    const mediaType = mediaParts[0].inlineData?.mimeType.startsWith('image') ? 'gambar' : 'dokumen/file';
                    // Cek jika mediaParts hanya berisi URL (YouTube/Instagram/URL Media Sosial lainnya)
                    if (mediaParts.every(p => !p.inlineData)) {
                       // Biarkan query yang sudah dibuat oleh logika URL sebelumnya
                    } else if (mediaParts[0].inlineData?.mimeType.startsWith('audio')) {
                        // Prompt audio sudah ditangani di bagian C
                    } else {
                        queryText = `Mohon analisis ${mediaType} yang terlampir ini secara mendalam.`;
                    }
                }
                
                // --- Eksekusi Agent Mole AI ---
                // Final check: Pastikan bot merespons jika isGeminiQuery true ATAU ada query teks
                if (isGeminiQuery || queryText.length > 0 || extractDangerousUrl(messageText).length > 0) {
                    await handleGeminiRequest(sock, from, queryText, mediaParts);
                    return;
                }
                
                if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') {
                    console.log(`[SKIP] Pesan non-teks/non-media yang tidak didukung: ${messageType}`);
                    await sock.sendPresenceUpdate('available', from);
                }

            } catch (e) {
                // Jaring pengaman terakhir untuk mencegah bot mati total
                console.error("-----------------------------------------------------");
                console.error("🚨 CRITICAL: UNHANDLED ERROR IN MESSAGES.UPSERT:", e);
                console.error("-----------------------------------------------------");
                // Tidak perlu mengirim pesan balasan karena ini adalah error internal
            }
        });

    } catch (error) {
        console.error("-----------------------------------------------------");
        console.error("🚨 CRITICAL: GAGAL INISIALISASI BOT:", error);
        console.error("-----------------------------------------------------");
    }
}

// Jalankan bot
startSock();
