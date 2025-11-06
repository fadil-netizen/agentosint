// index.js

const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    downloadContentFromMessage, 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const setting = require('./setting'); 
const { GoogleGenAI } = require('@google/genai');
const mammoth = require('mammoth'); 
const XLSX = require('xlsx'); 
const pptx2json = require('pptx2json'); 
const fs = require('fs'); 

const ai = setting.GEMINI_AI_INSTANCE;
const PREFIX = setting.PREFIX;
const CHAT_SESSIONS = setting.CHAT_SESSIONS; 
const GEMINI_MODEL_MAP = setting.GEMINI_MODEL_MAP;
const MODELS = setting.MODELS;
const SMART_MODE_SYSTEM_INSTRUCTION = setting.SMART_MODE_SYSTEM_INSTRUCTION; 
const GOOGLE_SEARCH_CONFIG = setting.GOOGLE_SEARCH_CONFIG; 
const PRIVATE_CHAT_STATUS = setting.PRIVATE_CHAT_STATUS; 


// --- FUNGSI BARU UNTUK MENGIRIM GAMBAR COMMAND (/norek) ---
async function handleSendImageCommand(sock, from, imagePath, caption) {
    try {
        await sock.sendPresenceUpdate('composing', from); 

        if (!fs.existsSync(imagePath)) {
            await sock.sendMessage(from, { text: `⚠️ Maaf, file gambar di path \`${imagePath}\` tidak ditemukan di server. Pastikan file ada di path tersebut.` });
            return;
        }

        const imageBuffer = fs.readFileSync(imagePath);

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


// --- Fungsi Helper untuk Multimodal (Gambar, Video & Dokumen) ---
function bufferToGenerativePart(buffer, mimeType) {
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType
        },
    };
}


// --- Fungsi Helper Ekstraksi Dokumen ---
async function extractTextFromDocument(buffer, mimeType) {
    // Ekstraksi DOCX/DOC
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === 'application/msword') {
        try {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return `*Dokumen DOCX/DOC (Dikonversi ke Teks):*\n\n${result.value}`;
        } catch (error) {
            console.error("Gagal ekstraksi DOCX:", error);
            return "*[GAGAL EKSTRAKSI DARI DOCX/DOC]*. Coba lagi atau pastikan format file valid.";
        }
    } 
    // Ekstraksi XLSX/XLS (SheetJS)
    else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === 'application/vnd.ms-excel') {
        try {
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            let allSheetText = "";

            workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(worksheet);
                const truncatedCsv = csv.substring(0, 10000); 

                allSheetText += `\n*-- SHEET: ${sheetName} (Dikonversi ke CSV) --*\n\`\`\`csv\n${truncatedCsv}\n\`\`\``;
            });

            return `*Dokumen XLSX/XLS (Data Dikonversi ke CSV):*\n${allSheetText}`;
        } catch (error) {
            console.error("Gagal ekstraksi XLSX:", error);
            return "*[GAGAL EKSTRAKSI DARI XLSX/XLS]*. Coba lagi atau pastikan format file valid.";
        }
    } 
    // Ekstraksi PPTX
    else if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
        try {
            const slidesData = await pptx2json.extract(buffer);
            let extractedText = "";

            slidesData.forEach((slide, index) => {
                const slideText = Array.isArray(slide.text) ? slide.text.join('\n') : slide.text;
                const notes = slide.notes || 'Tidak ada catatan pembicara.';

                extractedText += `\n\n*-- SLIDE ${index + 1} --*`;
                extractedText += `\n*Isi Slide:*\n${slideText || 'Tidak ada teks utama.'}`;
                extractedText += `\n*Catatan Pembicara:*\n${notes}`;
            });
            
            return `*Dokumen PPTX (Dikonversi ke Teks Per Slide):*\n${extractedText}`;

        } catch (error) {
            console.error("Gagal ekstraksi PPTX:", error);
            return "*[GAGAL EKSTRAKSI DARI PPTX]*. Coba lagi atau pastikan format file valid.";
        }
    }
    return `*Dokumen Tipe Tidak Dikenal:* ${mimeType}`;
}


// --- Fungsi Helper untuk Sesi Chat (Ingatan Otomatis & Tools) ---
function getOrCreateChat(jid) {
    const selectedModel = GEMINI_MODEL_MAP.get(jid) || MODELS.DEFAULT;
    
    if (CHAT_SESSIONS.has(jid)) {
        const chatInstance = CHAT_SESSIONS.get(jid);
        if (chatInstance.model !== selectedModel) {
            CHAT_SESSIONS.delete(jid); 
        } else {
             return chatInstance;
        }
    }

    let chatConfig = {
        config: {
            tools: [{ googleSearch: GOOGLE_SEARCH_CONFIG }], 
            ...(selectedModel === MODELS.SMART && { systemInstruction: SMART_MODE_SYSTEM_INSTRUCTION })
        }
    };
    
    const chat = ai.chats.create({ model: selectedModel, ...chatConfig });
    chat.model = selectedModel; 
    CHAT_SESSIONS.set(jid, chat);
    return chat;
}

// --- FUNGSI HELPER UNTUK CEK MENTION (FINAL) ---
function isBotMentioned(m, sock) {
    if (!sock.user) return false; 
    
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const botJidRaw = sock.user.id.split(':')[0];

    const contextInfo = m.message?.extendedTextMessage?.contextInfo;
    const messageText = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || m.message.documentMessage?.caption || ''; 

    const mentionedJids = contextInfo?.mentionedJid || [];
    if (mentionedJids.includes(botJid)) {
        return true;
    }

    const quotedParticipant = contextInfo?.participant;
    if (quotedParticipant === botJid) {
        return true;
    }
    
    if (messageText.includes('@' + botJidRaw)) {
        return true;
    }
    
    return false;
}

// --- Fungsi Utama untuk Berbicara dengan Gemini (Ingatan Aktif dan Multimodal) ---
async function handleGeminiRequest(sock, from, textQuery, mediaParts = []) {
    try {
        await sock.sendPresenceUpdate('composing', from); 

        // Dapatkan Waktu Server Saat Ini (WIB)
        const now = new Date();
        const serverTime = now.toLocaleString('id-ID', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZoneName: 'short', timeZone: 'Asia/Jakarta'
        });

        // Instruksi tambahan
        const contextInjection = 
            `*TANGGAL/WAKTU SERVER SAAT INI:* \`${serverTime}\`. ` +
            `*Instruksi Penting*: Gunakan Tool Google Search untuk mendapatkan informasi yang akurat, real-time yang relevan dengan pertanyaan pengguna.`;


        const chat = getOrCreateChat(from);
        const currentModel = chat.model;

        let contents = [...mediaParts];
        let finalQuery;

        if (textQuery.length > 0) {
            finalQuery = `${contextInjection}\n\n*Permintaan Pengguna:*\n${textQuery}`;
            contents.push(finalQuery);
        } 
        else if (mediaParts.length > 0) {
             const mediaType = mediaParts[0].inlineData.mimeType.startsWith('image') ? 'gambar' : 
                               mediaParts[0].inlineData.mimeType.startsWith('video') ? 'video' : 'dokumen';
             finalQuery = `${contextInjection}\n\n*Permintaan Default:*\nAnalisis ${mediaType} ini secara sangat mendalam dan detail.`;
             contents.push(finalQuery);
        } 
        else {
             finalQuery = 
                `${contextInjection}\n\n*Permintaan Default:*\nHalo! Saya Gemini. Anda bisa mengajukan pertanyaan, mengirim gambar, video, dokumen (PDF/TXT/DOCX/XLSX/PPTX), atau *voice note* setelah me-*tag* saya. Ketik ${PREFIX}menu untuk melihat daftar perintah.`;
             contents.push(finalQuery);
        }
        
        const response = await chat.sendMessage({ message: contents });

        const geminiResponse = response.text.trim();
        
        const modelName = currentModel === MODELS.FAST ? 'Fast Mode (gemini-2.5-flash)' : 'Smart Mode (gemini-2.5-pro)';
        const finalResponse =`*💠 Mode Aktif:* \`${modelName}\`\n${geminiResponse}`;

        await sock.sendMessage(from, { text: finalResponse });

    } catch (error) {
        console.error("Gagal memproses pesan dengan Gemini AI:", error);
        await sock.sendMessage(from, { text: "Maaf, terjadi kesalahan saat menghubungi Gemini AI. Pastikan file adalah format yang didukung (Gambar/Video/Dokumen) dan ukurannya tidak terlalu besar." });
    } finally {
        await sock.sendPresenceUpdate('available', from); 
    }
}


// --- Fungsi Khusus untuk Image Generation ---
async function handleImageGeneration(sock, from, prompt) {
    try {
        await sock.sendPresenceUpdate('composing', from); 

        const model = MODELS.IMAGE_GEN; 

        console.log(`[GEMINI DRAW] Menerima permintaan: "${prompt}"`);

        const response = await ai.models.generateContent({
            model: model,
            contents: [prompt] 
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(
            part => part.inlineData && part.inlineData.mimeType.startsWith('image/')
        );
        
        if (imagePart) {
            const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
            
            await sock.sendMessage(from, { 
                image: imageBuffer, 
                caption: `✅ *Gambar Dibuat (Model: \`${model}\`):*\n"${prompt}"`
            });

        } else {
            console.error("[GEMINI DRAW ERROR] Respon tidak mengandung gambar. Respon teks:", response.text);
            await sock.sendMessage(from, { text: `Maaf, gagal membuat gambar untuk prompt: "${prompt}". Model hanya mengembalikan teks:\n${response.text}` });
        }

    } catch (error) {
        console.error("-----------------------------------------------------");
        console.error("🚨 GAGAL MEMPROSES IMAGE GENERATION:", error.message);
        console.error("-----------------------------------------------------");

        await sock.sendMessage(from, { 
            text: "Maaf, terjadi kesalahan saat mencoba membuat gambar dengan Gemini AI. Silakan cek konsol terminal untuk detail error lebih lanjut." 
        });
    } finally {
        await sock.sendPresenceUpdate('available', from); 
    }
}


// --- Fungsi Pengelolaan Perintah ---
async function resetUserMemory(sock, jid) {
    CHAT_SESSIONS.delete(jid);
    await sock.sendMessage(jid, { text: '*✅ Semua ingatan riwayat percakapan Anda telah dihapus*. Ingatan telah dimatikan.' });
}


async function changeModel(sock, jid, modelKey) {
    const newModel = MODELS[modelKey];
    const newModelName = modelKey === 'FAST' ? 'Fast Mode' : 'Smart Mode';
    
    GEMINI_MODEL_MAP.set(jid, newModel);
    CHAT_SESSIONS.delete(jid);

    await sock.sendMessage(jid, { text: `✅ Mode telah diganti menjadi *${newModelName}* (\`${newModel}\`). Ingatan baru akan dimulai.` });
}


// Fungsi utama untuk menjalankan bot
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info'); 
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log("Scan QR code ini dengan WhatsApp kamu!");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error) ? 
                (new Boom(lastDisconnect.error)).output.statusCode !== DisconnectReason.loggedOut :
                true; 

            if (shouldReconnect) {
                console.log('Koneksi tertutup, mencoba menyambung ulang secara otomatis...');
                startSock(); 
            } else {
                console.log('Koneksi ditutup. Anda telah logout.');
            }
        } else if (connection === 'open') {
            console.log('Bot siap digunakan! Ingatan Otomatis, Multimodal (Gambar, Video & Dokumen), Mode Cerdas, dan Google Search Aktif.');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Event listener untuk pesan masuk
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return; 

        const from = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');

        const messageType = Object.keys(m.message)[0];
        let messageText = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || m.message.documentMessage?.caption || '';
        
        const command = messageText.toLowerCase().split(' ')[0];
        const args = messageText.slice(command.length).trim();

        // ----------------------------------------------------------------------
        // --- LOGIKA PESAN SELAMAT DATANG PERTAMA KALI ---
        // ----------------------------------------------------------------------
        
        if (!isGroup) {
            const isFirstTime = !PRIVATE_CHAT_STATUS.has(from) && !CHAT_SESSIONS.has(from);
            const rawText = messageText.trim();
            
            if (isFirstTime && rawText.length > 0 && !rawText.startsWith(PREFIX)) {
                
                const welcomeMessage = `
Halo anda telah menghubungi fadil silahkan tunggu saya merespon atau.

    Ketik: \`2\`
    untuk memulai percakapan dengan chatbot.
    *jika anda berada di percakapan chatbot*
    Ketik: \`1\`
    (untuk keluar dari percakapan chatbot dan kembali menghubungi nomor ini).

*Petunjuk Singkat:*
- Untuk bertanya/kirim media dengan chatbot, aktifkan sesi dengan \`2\` terlebih dahulu.
- Ketik \`${PREFIX}menu\` untuk melihat daftar fitur lengkap.
                `.trim();

                await sock.sendMessage(from, { text: welcomeMessage });
                PRIVATE_CHAT_STATUS.set(from, false); 
                console.log(`[WELCOME] Mengirim pesan selamat datang ke ${from}. Status awal: Non-aktif.`);
                return; 
            }
        }

        // ----------------------------------------------------------------------
        // --- LOGIKA SESSION LOCK (KHUSUS CHAT PRIBADI) ---
        // ----------------------------------------------------------------------
        
        if (!isGroup) {
            const currentStatus = PRIVATE_CHAT_STATUS.get(from);
            const rawText = messageText.trim();

            if (rawText === '2') {
                PRIVATE_CHAT_STATUS.set(from, true);
                await sock.sendMessage(from, { text: `✅ *Sesi Chatbot Gemini telah diaktifkan!* Anda sekarang bisa langsung bertanya atau kirim media. Ketik \`1\` untuk keluar dari sesi.` });
                return; 
            }
            if (rawText === '1') {
                PRIVATE_CHAT_STATUS.set(from, false);
                CHAT_SESSIONS.delete(from); 
                await sock.sendMessage(from, { text: `❌ *Sesi Chatbot Gemini telah dinonaktifkan!* Bot akan diam. Ketik \`2\` untuk mengaktifkan sesi lagi.` });
                return;
            }
            
            if (!currentStatus && !messageText.toLowerCase().startsWith(PREFIX)) {
                return;
            }
        }
        
        // --- Penanganan Perintah Khusus (Command Logic) ---
        
        // --- FITUR BARU: /norek ---
        if (command === `${PREFIX}norek`) {
             // 🛑 PATH GAMBAR DITENTUKAN DI SINI
             const imagePath = './assets/norek_info.png'; 
             const caption = '*Berikut adalah informasi rekening dan QR Code untuk transfer.*';
             await handleSendImageCommand(sock, from, imagePath, caption);
             return;
        }
        // -------------------------

        if (command === `${PREFIX}menu`) {
            await sock.sendMessage(from, { text: setting.GEMINI_MENU });
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
                await sock.sendMessage(from, { text: "Mohon berikan deskripsi gambar yang ingin Anda buat, contoh: `"+ PREFIX +"draw seekor anjing astronaut di luar angkasa`" });
            }
            return;
        }
        
        // ----------------------------------------------------------------------
        // --- LOGIKA PEMROSESAN QUERY (FINAL) ---
        // ----------------------------------------------------------------------
        
        let queryText = messageText;
        let mediaParts = [];
        let isGeminiQuery = false;
        let isMentioned = false; 
        let documentExtractedText = null; 

        if (isGroup) {
            isMentioned = isBotMentioned(m, sock);

            if (!isMentioned) {
                return;
            }
            
            // Hapus mention dari query teks
            const botJidRaw = sock.user?.id?.split(':')[0]; 
            if (botJidRaw) {
                const botMentionRegex = new RegExp(`@${botJidRaw}`, 'g');
                queryText = queryText.replace(botMentionRegex, '').trim();
            }
        } 
        
        // A1. Pesan Gambar Langsung atau Balasan Gambar
        if (messageType === 'imageMessage' || (messageType === 'extendedTextMessage' && m.message.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage)) {
             const imageMsg = messageType === 'imageMessage' ? m.message.imageMessage : m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
             
             const stream = await downloadContentFromMessage(imageMsg, 'image');
             let buffer = Buffer.from([]);
             for await (const chunk of stream) {
                 buffer = Buffer.concat([buffer, chunk]);
             }

             mediaParts.push(bufferToGenerativePart(buffer, imageMsg.mimetype));
             isGeminiQuery = true;
        }
        
        // A2. Pesan Video Langsung atau Balasan Video (LOGIKA BARU)
        else if (messageType === 'videoMessage' || (messageType === 'extendedTextMessage' && m.message.extendedTextMessage.contextInfo?.quotedMessage?.videoMessage)) {
            const videoMsg = messageType === 'videoMessage' ? m.message.videoMessage : m.message.extendedTextMessage.contextInfo.quotedMessage.videoMessage;

            await sock.sendPresenceUpdate('composing', from); 
            
            const stream = await downloadContentFromMessage(videoMsg, 'video');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            
            console.log(`[VIDEO] Menerima video: ${videoMsg.mimetype}, ukuran: ${buffer.length} bytes`);

            // Tambahkan video sebagai GenerativePart untuk dianalisis oleh Gemini
            mediaParts.push(bufferToGenerativePart(buffer, videoMsg.mimetype));
            isGeminiQuery = true;
        }
        
        // B. Pemrosesan Dokumen (Langsung atau Balasan)
        else if (messageType === 'documentMessage' || (messageType === 'extendedTextMessage' && m.message.extendedTextMessage.contextInfo?.quotedMessage?.documentMessage)) {
            const documentMsg = messageType === 'documentMessage' 
                ? m.message.documentMessage 
                : m.message.extendedTextMessage.contextInfo.quotedMessage.documentMessage;

            const mimeType = documentMsg.mimetype;
            const validMimeTypes = [
                'application/pdf', 
                'text/plain',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 
                'application/msword', 
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 
                'application/vnd.ms-excel', 
                'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            ];

            if (validMimeTypes.includes(mimeType)) {
                await sock.sendPresenceUpdate('composing', from); 

                const stream = await downloadContentFromMessage(documentMsg, 'document');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                
                if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
                    mediaParts.push(bufferToGenerativePart(buffer, mimeType));
                } 
                else {
                    documentExtractedText = await extractTextFromDocument(buffer, mimeType);
                }
                
                isGeminiQuery = true;
            } else if (messageType === 'documentMessage') {
                await sock.sendMessage(from, { text: `⚠️ Maaf, tipe file dokumen \`${mimeType}\` belum didukung. Hanya mendukung *PDF, TXT, DOCX/DOC, XLSX/XLS*, dan *PPTX*.` });
                await sock.sendPresenceUpdate('available', from);
                return;
            }
        }
        
        // C. Deteksi Voice Note/Audio (PENCEGAHAN/PLACEHOLDER)
        else if (messageType === 'audioMessage' || (messageType === 'extendedTextMessage' && m.message.extendedTextMessage.contextInfo?.quotedMessage?.audioMessage)) {
            const audioMsg = messageType === 'audioMessage' 
                ? m.message.audioMessage 
                : m.message.extendedTextMessage.contextInfo.quotedMessage.audioMessage;
            
            if (audioMsg.mimetype.includes('audio')) {
                const stream = await downloadContentFromMessage(audioMsg, 'audio');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                
                await sock.sendPresenceUpdate('composing', from);
                await sock.sendMessage(from, {
                    text: `*Terima kasih atas Voice Note Anda!* 🗣️\n\n⚠️ Fitur transkripsi Voice Note (Audio ke Teks) dinonaktifkan untuk menghemat penggunaan sumber daya bot ini, mohon maaf ya`,
                    audio: buffer,
                    mimetype: audioMsg.mimetype,
                    ptt: true 
                });
                
                await sock.sendPresenceUpdate('available', from);
                return;
            }
        }
        
        // D. Perintah Teks
        if (queryText.length > 0 && !isGeminiQuery) {
            isGeminiQuery = true;
        }
        
        // E. Gabungkan Query Teks dan Teks Ekstraksi Dokumen
        if (documentExtractedText) {
             queryText = `${documentExtractedText}\n\n*Permintaan Analisis Pengguna:*\n${queryText.length > 0 ? queryText : 'Mohon analisis dokumen ini.'}`;
        }
        
        // --- Eksekusi Gemini ---
        if (isGeminiQuery || (isGroup && isMentioned)) {
            await handleGeminiRequest(sock, from, queryText, mediaParts);
            return;
        }
    });
}

// Jalankan bot
startSock();
