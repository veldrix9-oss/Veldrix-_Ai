const https = require('https');
const http = require('http');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ========== Same config style ==========
const config = {
    timeout: 30000,
    retries: 5,
    delay: 2000,
    version: '2.0.0'
};

// ========== Environment ==========
require('dotenv').config({ path: './config.env' });
const OWNER = process.env.OWNER_NUMBER || '255748529340';
const PORT = process.env.WEB_PORT || 3000;
const SESSION_FOLDER = './session';
const PREFIX = process.env.PREFIX || '!';

// ========== Web server (optional) ==========
const app = express();
app.use(express.json());

let sock = null;
let isConnected = false;
let startTime = Date.now();
let pairingAttempted = false;
let reconnectTimeout = null;

// ========== MAIN FUNCTION (replaces the old request/eval) ==========
async function connectToWhatsApp() {
    console.log('[BWM-XMD] Connecting to WhatsApp...');
    if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[BWM-XMD] Using Baileys version: ${version.join('.')}`);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        version: version,
        logger: pino({ level: 'silent' }),
        browser: ['VELDRIX-AI', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // --- Pairing code ---
        if ((connection === 'connecting' || update.qr) && !state.creds.registered && !pairingAttempted) {
            pairingAttempted = true;
            console.log('[BWM-XMD] Requesting pairing code...');
            const phoneNumber = OWNER.replace(/\D/g, '');
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`[BWM-XMD] Your pairing code: ${code}`);
                console.log('[BWM-XMD] Open WhatsApp → Linked Devices → Link with phone number');
            } catch (err) {
                console.error('[BWM-XMD] Pairing code request failed:', err.message);
                pairingAttempted = false;
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            isConnected = false;
            console.log(`[BWM-XMD] Connection closed. Code: ${statusCode || 'unknown'}`);
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('[BWM-XMD] Logged out, deleting session...');
                try { fs.rmSync(SESSION_FOLDER, { recursive: true, force: true }); } catch (e) {}
                pairingAttempted = false;
                clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                pairingAttempted = false;
                clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => connectToWhatsApp(), 10000);
            }
        }

        if (connection === 'open') {
            isConnected = true;
            console.log('[BWM-XMD] ✅ Bot is online!');
        }
    });

    // --- Message handler ---
    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        if (!m.message || m.key.fromMe) return;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const sender = m.key.remoteJid;
        if (text.startsWith(PREFIX)) {
            const cmd = text.slice(PREFIX.length).trim().toLowerCase();
            await handleCommand(cmd, sender, m);
        }
    });

    return sock;
}

async function handleCommand(cmd, sender, msg) {
    const reply = async (txt) => {
        try { await sock.sendMessage(sender, { text: txt }); } catch (err) {}
    };
    switch (cmd) {
        case 'menu':
            await reply(`╔══════════════════╗
   𝐕𝐄𝐋𝐃𝐑𝐈𝐗 𝐀𝐈
╠══════════════════╣
║ !menu - Show this ║
║ !ping - Test     ║
║ !status - Bot info║
║ !owner - Contact  ║
╚══════════════════╝`);
            break;
        case 'ping': await reply('🏓 Pong!'); break;
        case 'status': {
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            await reply(`📊 Status:\n• Bot: ${isConnected ? 'Online ✅' : 'Offline ❌'}\n• Uptime: ${uptime}s\n• Owner: ${OWNER}`);
            break;
        }
        case 'owner': await reply(`👤 Owner: ${OWNER}`); break;
        default: break;
    }
}

// ========== Web server (same as before) ==========
app.get('/', (req, res) => {
    res.send(`
        <html><head><title>VELDRIX AI - Status</title></head>
        <body style="background:#0d0d0d; color:#00ffcc; font-family:monospace; padding:20px;">
            <h1>🚀 VELDRIX AI</h1>
            <p>Status: <span style="color:${isConnected ? '#00ff00' : '#ff0000'}">${isConnected ? 'ONLINE' : 'OFFLINE'}</span></p>
            <p>Uptime: ${Math.floor((Date.now() - startTime) / 1000)}s</p>
            <p>Owner: ${OWNER}</p>
            <p>Session: ${fs.existsSync(path.join(SESSION_FOLDER, 'creds.json')) ? 'Active' : 'None'}</p>
            <hr><p><a href="/status" style="color:#00ffcc;">JSON Status</a></p>
            <p style="margin-top:30px; color:#888;">VELDRIX AI © 2026</p>
        </body></html>
    `);
});

app.get('/status', (req, res) => {
    res.json({
        status: isConnected ? 'online' : 'offline',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        owner: OWNER,
        session: fs.existsSync(path.join(SESSION_FOLDER, 'creds.json')),
        timestamp: new Date().toISOString()
    });
});

// ========== Retry logic (same style as your original) ==========
async function initialize() {
    console.log('[BWM-XMD] Starting...');
    let lastError;
    for (let i = 0; i < config.retries; i++) {
        try {
            await connectToWhatsApp();
            // If connection succeeds without error, break
            return;
        } catch (err) {
            lastError = err;
            console.log(`[BWM-XMD] Attempt ${i + 1} failed, retrying...`);
            await wait(config.delay * (i + 1));
        }
    }
    console.log('[BWM-XMD] Boot failed after all retries');
    process.exit(1);
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ========== Start server and bot ==========
app.listen(PORT, () => console.log(`[BWM-XMD] Web dashboard running on port ${PORT}`));
initialize().catch(console.error);
