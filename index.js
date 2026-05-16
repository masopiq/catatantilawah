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

        // ======================
        // REMOVE COMMAND
        // ======================

        const rawInput = text.replace("/tilawah", "").trim();

        if (!rawInput) {
            await bot.sendMessage(
                msg.chat.id,

                `❌ Format salah

Contoh:

/tilawah al baqarah 280 286 -> an nisa 1 20`,
            );

            return;
        }

        // ======================
        // DATE
        // ======================

        const tanggal = new Date().toLocaleDateString("id-ID", {
            timeZone: "Asia/Jakarta",

            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
        });

        // ======================
        // REPORT
        // ======================

        let totalKeseluruhan = 0;

        let report = `📖 Progress Tilawah

👤 ${user} • ${tanggal}

`;

        // ======================
        // RANGE MODE
        // ======================

        if (rawInput.includes("->")) {
            const rangeParts = rawInput.split("->").map((v) => v.trim());

            if (rangeParts.length !== 2) {
                await bot.sendMessage(
                    msg.chat.id,

                    `❌ Format range salah

Contoh:

/tilawah al baqarah 280 286 -> an nisa 1 20`,
                );

                return;
            }

            // ======================
            // START
            // ======================

            const startParts = rangeParts[0].trim().split(/\s+/);

            const startAyat = parseInt(startParts[startParts.length - 2], 10);

            const stopAyatAwal = parseInt(startParts[startParts.length - 1], 10);

            const startSurahInput = startParts.slice(0, startParts.length - 2).join(" ");

            const startSurahName = findSurah(startSurahInput);

            // ======================
            // END
            // ======================

            const endParts = rangeParts[1].trim().split(/\s+/);

            const startAyatAkhir = parseInt(endParts[endParts.length - 2], 10);

            const stopAyatAkhir = parseInt(endParts[endParts.length - 1], 10);

            const endSurahInput = endParts.slice(0, endParts.length - 2).join(" ");

            const endSurahName = findSurah(endSurahInput);

            // ======================
            // VALIDATION
            // ======================

            if (!startSurahName || !endSurahName) {
                await bot.sendMessage(msg.chat.id, "❌ Surah tidak dikenali");

                return;
            }

            const startSurah = surahList.find((s) => s.nama === startSurahName);

            const endSurah = surahList.find((s) => s.nama === endSurahName);

            if (!startSurah || !endSurah) {
                await bot.sendMessage(msg.chat.id, "❌ Data surah tidak ditemukan");

                return;
            }

            if (startSurah.nomor > endSurah.nomor) {
                await bot.sendMessage(msg.chat.id, "❌ Urutan surah tidak valid");

                return;
            }

            // ======================
            // LOOP SURAH
            // ======================

            for (let i = startSurah.nomor; i <= endSurah.nomor; i++) {
                const surah = surahList.find((s) => s.nomor === i);

                if (!surah) continue;

                let start = 1;

                let stop = surah.ayat;

                // awal
                if (surah.nomor === startSurah.nomor) {
                    start = startAyat;

                    stop = stopAyatAwal;
                }

                // akhir
                if (surah.nomor === endSurah.nomor) {
                    start = startAyatAkhir;

                    stop = stopAyatAkhir;
                }

                // surah sama
                if (startSurah.nomor === endSurah.nomor) {
                    start = startAyat;

                    stop = stopAyatAkhir;
                }

                // validate
                if (stop < start) {
                    report += `❌ Range invalid
• ${surah.nama}

`;

                    continue;
                }

                if (stop > surah.ayat) {
                    report += `❌ Ayat melebihi batas
• ${surah.nama}

`;

                    continue;
                }

                const jumlahAyat = stop - start + 1;

                totalKeseluruhan += jumlahAyat;

                // save
                await saveToSheet([
                    new Date().toLocaleString("sv-SE", {
                        timeZone: "Asia/Jakarta",
                    }),

                    user,

                    surah.nama,

                    start,

                    stop,

                    jumlahAyat,
                ]);

                // report
                report += `📚 ${surah.nama}
📍 ${start} - ${stop}
📊 ${jumlahAyat} ayat

`;
            }
        }

        // ======================
        // MULTI MANUAL MODE
        // ======================
        else {
            const entries = rawInput
                .split(";")
                .map((e) => e.trim())
                .filter(Boolean);

            for (const entry of entries) {
                try {
                    const parts = entry.trim().split(/\s+/);

                    if (parts.length < 3) {
                        report += `❌ Format invalid
• ${entry}

`;

                        continue;
                    }

                    const startAyat = parseInt(parts[parts.length - 2], 10);

                    const stopAyat = parseInt(parts[parts.length - 1], 10);

                    if (isNaN(startAyat) || isNaN(stopAyat)) {
                        report += `❌ Ayat invalid
• ${entry}

`;

                        continue;
                    }

                    if (stopAyat < startAyat) {
                        report += `❌ Range invalid
• ${entry}

`;

                        continue;
                    }

                    const surahInput = parts.slice(0, parts.length - 2).join(" ");

                    const surah = findSurah(surahInput);

                    if (!surah) {
                        report += `❌ Surah tidak dikenali
• ${entry}

`;

                        continue;
                    }

                    const surahData = surahList.find((s) => s.nama === surah);

                    if (stopAyat > surahData.ayat) {
                        report += `❌ Ayat melebihi batas
• ${surah}

`;

                        continue;
                    }

                    const jumlahAyat = stopAyat - startAyat + 1;

                    totalKeseluruhan += jumlahAyat;

                    await saveToSheet([
                        new Date().toLocaleString("sv-SE", {
                            timeZone: "Asia/Jakarta",
                        }),

                        user,

                        surah,

                        startAyat,

                        stopAyat,

                        jumlahAyat,
                    ]);

                    report += `📚 ${surah}
📍 ${startAyat} - ${stopAyat}
📊 ${jumlahAyat} ayat

`;
                } catch (err) {
                    console.error(err);

                    report += `❌ Gagal memproses
• ${entry}

`;
                }
            }
        }

        // ======================
        // FOOTER
        // ======================

        report += `━━━━━━━━━━━━━━
✨ Total keseluruhan • ${totalKeseluruhan} ayat`;

        // ======================
        // SEND
        // ======================

        await bot.sendMessage(process.env.GROUP_ID, report);

        await bot.sendMessage(msg.chat.id, "✅ Tilawah berhasil dicatat");
    } catch (err) {
        console.error(err);

        await bot.sendMessage(msg.chat.id, "❌ Terjadi kesalahan");
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
    "25 5 * * *",
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
    "25 18 * * *",
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
