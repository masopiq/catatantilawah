const fs = require("fs");

if (process.env.GOOGLE_CREDENTIALS) {
    fs.writeFileSync("credentials.json", Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64"));
}

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Google Sheets Auth
const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
    version: "v4",
    auth,
});

const SHEET_PREFIX = "Tilawah";

function getSheetName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${SHEET_PREFIX}_${year}_${month}`;
}

async function ensureSheetExists(sheetName) {
    const res = await sheets.spreadsheets.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
    });

    const sheetExists = res.data.sheets.some((s) => s.properties.title === sheetName);

    if (!sheetExists) {
        console.log("📄 Membuat sheet baru:", sheetName);

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.SPREADSHEET_ID,
            requestBody: {
                requests: [
                    {
                        addSheet: {
                            properties: {
                                title: sheetName,
                            },
                        },
                    },
                ],
            },
        });

        // Tambahkan header
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: `${sheetName}!A1:F1`,
            valueInputOption: "RAW",
            requestBody: {
                values: [["Tanggal", "Nama", "Surah", "Start_Ayat", "Stop_Ayat", "Jumlah_Ayat"]],
            },
        });
    }
}

async function saveToSheet(data) {
    const sheetName = getSheetName();

    await ensureSheetExists(sheetName);

    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${sheetName}!A:F`, // ✅ FIX
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [data],
        },
    });
}

const surahList = require("./surah-list");

// normalize string
function normalizeText(text) {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// cari surah paling cocok
function findSurah(input) {
    const normInput = normalizeText(input);

    // exact match
    for (const s of surahList) {
        if (normalizeText(s) === normInput) return s;
    }

    // partial match
    for (const s of surahList) {
        if (normalizeText(s).includes(normInput)) return s;
    }

    return null;
}

bot.on("message", async (msg) => {
    try {
        if (!msg.text) return;

        const text = msg.text.trim().replace(/\s+/g, " ");
        const user = msg.from.first_name;

        if (!text.toLowerCase().startsWith("/tilawah")) return;

        const parts = text.split(" ");

        if (parts.length < 4) throw new Error("Format salah");

        const startAyat = parseInt(parts[parts.length - 2], 10);
        const stopAyat = parseInt(parts[parts.length - 1], 10);

        const surahInput = parts.slice(1, parts.length - 2).join(" ");
        const surah = findSurah(surahInput);

        if (!surah) throw new Error("Surah tidak dikenali");

        const jumlahAyat = stopAyat - startAyat + 1;

        const tanggal = new Date().toLocaleDateString("id-ID", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
        });

        const report = `📖 Progress Tilawah

👤 ${user} | ${tanggal}
📚 Surat :${surah}
📍 Ayat  : ${startAyat} - ${stopAyat}
📊 Total : ${jumlahAyat} ayat`;

        await saveToSheet([new Date().toISOString(), user, surah, startAyat, stopAyat, jumlahAyat]);

        await bot.sendMessage(process.env.GROUP_ID, report);
        await bot.sendMessage(msg.chat.id, "✅ Semoga tilawah hari ini tercatat sebagai amal sholeh");
    } catch (err) {
        bot.sendMessage(
            msg.chat.id,
            `❌ ${err.message}

Gunakan:
/tilawah NamaSurah Start Stop

Contoh:
/tilawah al baqarah 1 5`,
        );
    }
});

async function getWeeklyStats() {
    const sheetName = getSheetName();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
    });

    const rows = res.data.values;

    if (!rows || rows.length < 2) return [];

    const now = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(now.getDate() - 7);

    const stats = {};

    for (let i = 1; i < rows.length; i++) {
        const [tanggal, nama, , , , jumlah] = rows[i];

        const date = new Date(tanggal);

        if (date >= sevenDaysAgo && date <= now) {
            const jml = parseInt(jumlah, 10) || 0;

            if (!stats[nama]) stats[nama] = 0;
            stats[nama] += jml;
        }
    }

    // convert ke array & sort desc
    return Object.entries(stats)
        .map(([nama, total]) => ({ nama, total }))
        .sort((a, b) => b.total - a.total);
}

async function getMonthlyStats() {
    const sheetName = getSheetName();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
    });

    const rows = res.data.values || [];

    if (rows.length < 2) return [];

    const stats = {};

    for (let i = 1; i < rows.length; i++) {
        const [, nama, , , , jumlah] = rows[i];

        const jml = parseInt(jumlah, 10) || 0;

        if (!stats[nama]) {
            stats[nama] = 0;
        }

        stats[nama] += jml;
    }

    return Object.entries(stats)
        .map(([nama, total]) => ({ nama, total }))
        .sort((a, b) => b.total - a.total);
}

function getRankIcon(index) {
    switch (index) {
        case 0:
            return "👑";
        case 1:
            return "🥈";
        case 2:
            return "🥉";
        default:
            return "▫️";
    }
}

bot.onText(/\/summary/, async (msg) => {
    try {
        const weekly = await getWeeklyStats();
        const monthly = await getMonthlyStats();

        const tanggal = new Date().toLocaleDateString("id-ID", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
        });

        let text = `📊 *Resume Tilawah*\n`;
        text += `🗓️ ${tanggal}\n\n`;

        // ======================
        // WEEKLY
        // ======================
        text += `━━━━━━━━━━━━━━━━━━\n`;
        text += `*Resume Minggu Ini*\n\n`;

        if (weekly.length === 0) {
            text += `Belum ada data tilawah minggu ini\n\n`;
        } else {
            weekly.forEach((u, i) => {
                const icon = getRankIcon(i);

                text += `${icon} *${u.nama}* • ${u.total} ayat\n`;
            });
        }

        // ======================
        // MONTHLY
        // ======================
        text += `━━━━━━━━━━━━━━━━━━\n`;
        text += `*Resume Bulan Ini*\n\n`;

        if (monthly.length === 0) {
            text += `Belum ada data tilawah bulan ini\n\n`;
        } else {
            monthly.forEach((u, i) => {
                const icon = getRankIcon(i);

                text += `${icon} *${u.nama}* • ${u.total} ayat\n`;
            });
        }

        // ======================
        // FOOTER
        // ======================
        text += `━━━━━━━━━━━━━━━━━━\n`;
        text += `✨ Tetap istiqomah dalam tilawah\n`;

        await bot.sendMessage(msg.chat.id, text, {
            parse_mode: "Markdown",
        });
    } catch (err) {
        console.error(err);

        bot.sendMessage(msg.chat.id, "❌ Gagal mengambil statistik");
    }
});

const cron = require("node-cron");

cron.schedule(
    "0 5 * * *",
    async () => {
        const tanggal = new Date().toLocaleDateString("id-ID", {
            timeZone: "Asia/Jakarta",
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
        });

        const message = `🌅 *Reminder Tilawah Pagi*

🗓️ ${tanggal}

✨ Jangan lupa memulai hari dengan tilawah

📖 _"Awali hari dengan membaca Al Quran"_`;

        await bot.sendMessage(process.env.GROUP_ID, message, {
            parse_mode: "Markdown",
        });

        console.log("Reminder pagi terkirim");
    },
    {
        timezone: "Asia/Jakarta",
    },
);

cron.schedule(
    "55 14 * * *",
    async () => {
        const tanggal = new Date().toLocaleDateString("id-ID", {
            timeZone: "Asia/Jakarta",
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
        });

        const message = `🌙 *Reminder Tilawah Malam*

🗓️ ${tanggal}

✨ Sudahkah tilawah hari ini?

📖 _"Bacalah Al-Qur'an, karena ia akan datang memberi syafaat"_`;

        await bot.sendMessage(process.env.GROUP_ID, message, {
            parse_mode: "Markdown",
        });

        console.log("Reminder malam terkirim");
    },
    {
        timezone: "Asia/Jakarta",
    },
);
