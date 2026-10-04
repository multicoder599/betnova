require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const http = require('http');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// ==========================================
// CORS CONFIGURATION
// ==========================================
const ALLOWED_ORIGINS = [
    'https://betnova.co.ke',
    'https://www.betnova.co.ke',
    'https://api.betnova.co.ke',
    'http://127.0.0.1:3002',
    'http://localhost:3002',
];

// CORS is handled entirely by nginx (api.betnova.co.ke server block).
// Do NOT add Express cors() here — two Access-Control-Allow-Origin headers make
// browsers reject the response ("multiple values ... but only one is allowed").
// Requests that reach Express directly (localhost dev, curl) don't need CORS.


app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ENVIRONMENT VARIABLES — VALIDATED
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const MEGAPAY_API_KEY = process.env.MEGAPAY_API_KEY || "MGPYGwiUK0J7";
const MEGAPAY_EMAIL = process.env.MEGAPAY_EMAIL || "gleah6423@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS;

if (!MONGO_URI) {
    console.error("❌ CRITICAL: MONGO_URI is not set in .env file!");
}

// ==========================================
// TELEGRAM BOT UTILITY
// ==========================================
async function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("⚠️ Telegram credentials missing.");
        return;
    }
    const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
        console.log("✅ Telegram sent");
    } catch (err) {
        console.error("❌ Telegram error:", err.message);
    }
}

// ==========================================
// MONGODB CONNECTION — ROBUST WITH RETRY
// ==========================================
let dbConnected = false;

async function connectDB() {
    if (!MONGO_URI) {
        console.error("❌ Cannot connect: MONGO_URI is undefined");
        return false;
    }
    try {
        mongoose.set('strictQuery', false);
        mongoose.set('bufferCommands', true);
        mongoose.set('bufferTimeoutMS', 30000);

        const conn = await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
            minPoolSize: 2
        });

        dbConnected = true;
        console.log("✅ MongoDB connected:", conn.connection.name, "@", conn.connection.host);
        return true;
    } catch (err) {
        dbConnected = false;
        console.error("❌ MongoDB connection failed:", err.message);
        setTimeout(connectDB, 5000);
        return false;
    }
}

mongoose.connection.on('disconnected', function() {
    dbConnected = false;
    console.log("⚠️ MongoDB disconnected. Reconnecting...");
    setTimeout(connectDB, 5000);
});

mongoose.connection.on('error', function(err) {
    console.error("❌ MongoDB connection error:", err.message);
});

connectDB();

// ==========================================
// DB HEALTH CHECK MIDDLEWARE
// ==========================================
function requireDB(req, res, next) {
    if (!dbConnected || mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            success: false,
            message: 'Database is temporarily unavailable. Please try again in a moment.'
        });
    }
    next();
}

// ==========================================
// MODELS
// ==========================================
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    bonusBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null },
    notifications: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const betSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    stake: { type: Number, required: true },
    potentialWin: { type: Number, default: 0 },
    selections: { type: Array, default: [] },
    type: { type: String, default: 'Sports' },
    status: { type: String, default: 'Open' },
    createdAt: { type: Date, default: Date.now }
});
const Bet = mongoose.model('Bet', betSchema);

const transactionSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    type: { type: String, required: true },
    method: { type: String, required: true },
    amount: { type: Number, required: true },
    fee: { type: Number, default: 0 },
    status: { type: String, default: 'Success' },
    gatewayRef: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const liveGameSchema = new mongoose.Schema({
    id: Number, category: String, home: String, away: String,
    odds: String, draw: String, away_odds: String, time: String,
    status: { type: String, default: 'upcoming' },
    commenceTime: { type: Date }
}, { strict: false });
const LiveGame = mongoose.model('LiveGame', liveGameSchema);

const virtualResultSchema = new mongoose.Schema({
    season: Number, matchday: Number, home: String, away: String,
    hs: Number, as: Number, odds: Object,
    createdAt: { type: Date, default: Date.now }
});
const VirtualResult = mongoose.model('VirtualResult', virtualResultSchema);

const matchResultSchema = new mongoose.Schema({
    matchName: { type: String, required: true, unique: true },
    hs: { type: Number, required: true },
    as: { type: Number, required: true },
    status: { type: String, default: 'FINISHED' },
    createdAt: { type: Date, default: Date.now }
});
const MatchResult = mongoose.model('MatchResult', matchResultSchema);

const sharedBetslipSchema = new mongoose.Schema({
    bookingCode: { type: String, required: true, unique: true },
    selections: { type: Array, required: true },
    createdAt: { type: Date, default: Date.now, expires: '48h' }
});
const SharedBetslip = mongoose.model('SharedBetslip', sharedBetslipSchema);

const adminConfigSchema = new mongoose.Schema({
    id: { type: String, default: "global" },
    aviatorWinChance: { type: Number, default: 30 },
    virtualsMargin: { type: Number, default: 1.20 },
    passwordHash: { type: String, default: '' }
});
const AdminConfig = mongoose.model('AdminConfig', adminConfigSchema);

// ==========================================
// INIT ADMIN PASSWORD FROM ENV
// ==========================================
async function initAdmin() {
    try {
        if (!dbConnected) return;
        let conf = await AdminConfig.findOne({ id: "global" });
        if (!conf) {
            conf = await AdminConfig.create({ id: "global" });
        }
        if (ADMIN_PASSWORD) {
            // Env is the source of truth: (re)hash whenever the stored hash
            // doesn't match — fixes a stale/missing hash (e.g. .env var was
            // renamed or the DB was seeded before the env existed).
            const matches = conf.passwordHash ? await bcrypt.compare(ADMIN_PASSWORD, conf.passwordHash) : false;
            if (!matches) {
                const salt = await bcrypt.genSalt(10);
                conf.passwordHash = await bcrypt.hash(ADMIN_PASSWORD, salt);
                await conf.save();
                console.log("🔐 Admin password synced from ENV");
            }
        }
    } catch(e) {
        console.error("Admin init error:", e);
    }
}
connectDB().then(() => initAdmin());

// ==========================================
// GLOBAL CONFIG CACHE
// ==========================================
let globalConfig = { aviatorWinChance: 30, virtualsMargin: 1.20 };
setInterval(async () => {
    try {
        if (!dbConnected) return;
        let conf = await AdminConfig.findOne({ id: "global" });
        if (conf) {
            globalConfig.aviatorWinChance = conf.aviatorWinChance;
            globalConfig.virtualsMargin = conf.virtualsMargin;
        } else {
            await AdminConfig.create({ id: "global" });
        }
    } catch(e) {}
}, 15000);

// ==========================================
// NOTIFICATIONS
// ==========================================
app.get('/api/notifications/:phone', requireDB, async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: "User not found" });
        const unreadNotifs = user.notifications.filter(function(n) { return n.isRead === false; });
        if (unreadNotifs.length > 0) {
            user.notifications.forEach(function(n) { n.isRead = true; });
            user.markModified('notifications');
            await user.save();
        }
        res.json({ success: true, notifications: unreadNotifs.slice().reverse() });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

async function sendPushNotification(phone, title, message, type) {
    try {
        if (!dbConnected) return;
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;
        const notifObj = {
            id: "N-" + Date.now() + Math.floor(Math.random() * 1000),
            title: title, message: message, type: type,
            isRead: false, createdAt: new Date()
        };
        await User.updateMany(
            { $or: [{ phone: phone }, { phone: formattedPhone }] },
            { $push: { notifications: notifObj } }
        );
    } catch(e) { console.error("Notification Save Error", e); }
}

// ==========================================
// AUTH
// ==========================================
app.post('/api/register', requireDB, async (req, res) => {
    try {
        const { phone, password, name, ref } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password required.' });
        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ success: false, message: 'Phone already registered.' });
        let referredByPhone = null;
        if (ref) {
            const cleanRef = ref.replace(/(APX-|MGO-)/i, '');
            const allUsers = await User.find({});
            const referrer = allUsers.find(function(u) {
                return Buffer.from(u.phone).toString('base64').substring(0, 8).toUpperCase() === cleanRef;
            });
            if (referrer) referredByPhone = referrer.phone;
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = new User({ phone, password: hashedPassword, name: name || 'New Player', balance: 0, bonusBalance: 0, referredBy: referredByPhone });
        await newUser.save();
        await sendTelegramMessage("🚨 <b>NEW REGISTRATION</b> 🚨\n\n👤 <b>Name:</b> " + newUser.name + "\n📱 <b>Phone:</b> " + newUser.phone + "\n🔗 <b>Referred By:</b> " + (referredByPhone || 'None'));
        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, bonusBalance: newUser.bonusBalance, phone: newUser.phone } });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/login', requireDB, async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            if (password === user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                await user.save();
            } else {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
        }
        res.json({ success: true, user: { name: user.name, balance: user.balance, bonusBalance: user.bonusBalance || 0, phone: user.phone } });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/change-password', requireDB, async (req, res) => {
    try {
        const { userPhone, currentPassword, newPassword } = req.body;
        if (!userPhone || !currentPassword || !newPassword)
            return res.status(400).json({ success: false, message: 'All fields required.' });
        if (newPassword.length < 8)
            return res.status(400).json({ success: false, message: 'Password must be 8+ chars.' });
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        const isMatch = await bcrypt.compare(currentPassword, user.password) || currentPassword === user.password;
        if (!isMatch) return res.status(401).json({ success: false, message: 'Current password incorrect.' });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();
        await sendTelegramMessage("🔐 <b>PASSWORD CHANGED</b>\n\n📱 <b>Phone:</b> " + userPhone);
        res.json({ success: true, message: 'Password updated.' });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error.' }); }
});

// ==========================================
// BALANCE & TRANSACTIONS
// ==========================================
app.get('/api/balance/:phone', requireDB, async (req, res) => {
    try {
        // Lazy reconciliation: the app polls this right after an STK push, so
        // confirm any pending payments with MegaPay here — no webhook needed.
        const pendings = await Transaction.find({
            userPhone: req.params.phone,
            status: 'Pending',
            type: { $in: ['deposit', 'withdraw-fee'] },
            gatewayRef: { $ne: '' },
            createdAt: { $lt: new Date(Date.now() - 15000) }
        }).limit(5);
        for (const tx of pendings) await reconcileGatewayTx(tx);

        const user = await User.findOne({ phone: req.params.phone }).select('balance bonusBalance');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: user.balance, bonusBalance: user.bonusBalance || 0 });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/transactions/:phone', requireDB, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userPhone: req.params.phone }).sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, transactions });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ==========================================
// FINANCE: DEPOSIT & WITHDRAWAL
// ==========================================
app.post('/api/deposit', requireDB, async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 200) return res.status(400).json({ success: false, message: 'Minimum deposit is 200 KES.' });
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        let formattedPhone = userPhone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;
        const APP_URL = process.env.APP_URL || 'https://api.betnova.co.ke';
        const reference = "DEP" + Date.now();
        const payload = {
            api_key: MEGAPAY_API_KEY,
            email: MEGAPAY_EMAIL,
            amount: Math.round(Number(amount)),
            msisdn: formattedPhone,
            callback_url: APP_URL + "/api/megapay/webhook",
            description: "Account Deposit",
            reference: reference
        };
        const mgRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { timeout: 15000 });
        const mgData = mgRes.data || {};
        const gatewayRef = mgData.transaction_request_id || '';
        const stkOk = gatewayRef || String(mgData.success) === '200' || String(mgData.ResponseCode) === '0';
        if (!stkOk) {
            console.error("❌ MegaPay rejected deposit STK:", JSON.stringify(mgData));
            return res.status(502).json({ success: false, message: "Payment gateway rejected the request. Please try again." });
        }
        await Transaction.create({ refId: reference, userPhone: user.phone, type: 'deposit', method: method || 'M-Pesa', amount: Number(amount), status: 'Pending', gatewayRef: gatewayRef });
        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) {
        console.error("Deposit error:", error.message);
        res.status(500).json({ success: false, message: "Payment Gateway Error. Please try again." });
    }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    console.log("🔔 Webhook received:", JSON.stringify(data));
    try {
        if (!dbConnected) {
            console.error("❌ Webhook: DB not connected, cannot process payment");
            return;
        }
        var responseCode = data.ResponseCode;
        if (responseCode === undefined) responseCode = data.ResultCode;
        if (responseCode === undefined) responseCode = data.responseCode;
        if (responseCode === undefined) responseCode = data.resultCode;
        if (responseCode === undefined) responseCode = data.status;

        var isSuccess = responseCode == 0 || responseCode === "0" || responseCode === "Success" || responseCode === "success";
        if (!isSuccess) {
            console.log("⛔ Payment not successful. Code:", responseCode);
            return;
        }
        var amount = parseFloat(data.TransactionAmount || data.amount || data.Amount || data.transactionAmount);
        if (isNaN(amount) || amount <= 0) {
            console.error("❌ Invalid amount:", data);
            return;
        }
        var receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.receipt || data.transactionId || data.reference || ("MPESA-" + Date.now());
        var rawPhone = data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || data.phoneNumber;
        if (!rawPhone) {
            console.error("❌ No phone in webhook");
            return;
        }
        rawPhone = rawPhone.toString();
        var phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        var phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;
        const user = await User.findOne({ $or: [{ phone: phone0 }, { phone: phone254 }, { phone: rawPhone }] });
        if (!user) {
            console.error("❌ User not found:", rawPhone);
            return;
        }

        // MegaPay sends our STK reference back as TransactionReference (docs),
        // some builds send it as "reference" — accept both.
        var dataRef = data.reference || data.TransactionReference || '';

        // Duplicate-webhook guard: match on either the M-Pesa receipt OR our reference.
        var alreadyOr = [{ refId: receipt, status: 'Success' }];
        if (dataRef) alreadyOr.push({ refId: dataRef, status: 'Success' });
        const alreadySuccess = await Transaction.findOne({ $or: alreadyOr });
        if (alreadySuccess) {
            console.log("⚠️ Already processed successfully:", receipt);
            return;
        }

        let txUpdated = false;
        let pendingTx = await Transaction.findOne({ refId: receipt, status: 'Pending' });
        if (!pendingTx && dataRef) {
            pendingTx = await Transaction.findOne({ refId: dataRef, status: 'Pending' });
        }

        // ── WITHDRAWAL FEE: fee payments mark Success and STOP here —
        // they must NEVER credit the betting balance.
        var feeTx = await Transaction.findOne({ refId: receipt, type: 'withdraw-fee', status: 'Pending' });
        if (!feeTx && dataRef) {
            feeTx = await Transaction.findOne({ refId: dataRef, type: 'withdraw-fee', status: 'Pending' });
        }
        if (feeTx) {
            feeTx.status = 'Success';
            await feeTx.save();
            await sendPushNotification(feeTx.userPhone, "Odds Fee Paid ✅", "Your 15% withdrawal fee of KES " + feeTx.amount + " was received. Your withdrawal is being released.", "withdraw");
            await sendTelegramMessage("🧾 <b>WITHDRAWAL FEE PAID</b> 🧾\n\n👤 <b>User:</b> " + feeTx.userPhone + "\n💰 <b>Fee:</b> KES " + feeTx.amount + "\n🧾 <b>Ref:</b> " + feeTx.refId);
            return;
        }

        if (pendingTx) {
            pendingTx.status = 'Success';
            // refId stays stable (our DEP/WFEE reference) so status polling keeps working;
            // the M-Pesa receipt is recorded in method for accounting.
            pendingTx.method = 'M-Pesa ' + receipt;
            await pendingTx.save();
            txUpdated = true;
            console.log("✅ Updated pending transaction:", pendingTx.refId, "receipt:", receipt);
        }
        if (!txUpdated) {
            await Transaction.create({ refId: receipt, userPhone: user.phone, type: "deposit", method: "M-Pesa", amount: amount, status: "Success" });
        }

        // Safety net: never credit the balance for a fee-type transaction
        // (covers duplicate webhooks arriving after the fee was marked Success).
        var skipCredit = await Transaction.findOne({ refId: receipt, type: 'withdraw-fee', status: 'Success' });
        if (!skipCredit && dataRef) {
            skipCredit = await Transaction.findOne({ refId: dataRef, type: 'withdraw-fee', status: 'Success' });
        }
        if (skipCredit) { console.log("⚠️ Fee tx already handled, skipping balance credit:", receipt); return; }

        user.balance += amount;
        await user.save();

        await sendPushNotification(user.phone, "Deposit Successful", "Your deposit of KES " + amount + " has been credited.", "deposit");

        try {
            await sendTelegramMessage("✅ <b>DEPOSIT CONFIRMED</b> ✅\n\n👤 <b>User:</b> " + user.phone + "\n💰 <b>Amount:</b> KES " + amount + "\n🧾 <b>Receipt:</b> " + receipt);
        } catch (tgErr) {
            console.error("Telegram failed (non-critical):", tgErr.message);
        }

        if (user.referredBy) {
            const referrer = await User.findOne({ phone: user.referredBy });
            if (referrer) {
                referrer.bonusBalance = (referrer.bonusBalance || 0) + 50;
                await referrer.save();
                await Transaction.create({ refId: "REF-BONUS-" + receipt, userPhone: referrer.phone, type: "bonus", method: "Referral Deposit Bonus", amount: 50, status: "Success" });
                sendPushNotification(referrer.phone, "Referral Bonus! 🎁", "Your friend deposited! KES 50 added to your Bonus Wallet.", "bonus");
            }
        }
    } catch (err) {
        console.error("❌ Webhook Error:", err);
    }
});

// ==========================================
// PAYMENT RECONCILIATION (MegaPay status query)
// Webhooks are best-effort — MegaPay only calls them if a webhook URL
// is saved in their dashboard, and even then delivery can fail. This
// pull-based reconciler asks MegaPay directly and is the source of truth.
// ==========================================
async function creditDepositFromTx(tx, receiptLabel) {
    const user = await User.findOne({ phone: tx.userPhone });
    if (!user) return;
    user.balance += tx.amount;
    await user.save();
    await sendPushNotification(user.phone, "Deposit Successful", "Your deposit of KES " + tx.amount + " has been credited.", "deposit");
    try {
        await sendTelegramMessage("✅ <b>DEPOSIT CONFIRMED</b> ✅\n\n👤 <b>User:</b> " + user.phone + "\n💰 <b>Amount:</b> KES " + tx.amount + "\n🧾 <b>Receipt:</b> " + receiptLabel + "\n♻️ <i>via status reconciliation</i>");
    } catch (tgErr) { console.error("Telegram failed (non-critical):", tgErr.message); }
    if (user.referredBy) {
        const referrer = await User.findOne({ phone: user.referredBy });
        if (referrer) {
            referrer.bonusBalance = (referrer.bonusBalance || 0) + 50;
            await referrer.save();
            await Transaction.create({ refId: "REF-BONUS-" + tx.refId, userPhone: referrer.phone, type: "bonus", method: "Referral Deposit Bonus", amount: 50, status: "Success" });
            sendPushNotification(referrer.phone, "Referral Bonus! 🎁", "Your friend deposited! KES 50 added to your Bonus Wallet.", "bonus");
        }
    }
}

async function reconcileGatewayTx(tx) {
    try {
        if (!tx || tx.status !== 'Pending' || !tx.gatewayRef) return false;
        const r = await axios.post('https://megapay.co.ke/backend/v1/transactionstatus', {
            api_key: MEGAPAY_API_KEY,
            email: MEGAPAY_EMAIL,
            transaction_request_id: tx.gatewayRef
        }, { timeout: 15000 });
        const d = r.data || {};
        const completed = d.TransactionStatus === 'Completed' || String(d.TransactionCode) === '0';
        const failed = d.TransactionStatus === 'Failed' || d.TransactionStatus === 'Cancelled';
        if (failed) {
            await Transaction.updateOne({ _id: tx._id, status: 'Pending' }, { $set: { status: 'Failed' } });
            return false;
        }
        if (!completed) return false;
        // Atomically claim the flip so a racing webhook can't double-credit
        const claimed = await Transaction.findOneAndUpdate(
            { _id: tx._id, status: 'Pending' },
            { $set: { status: 'Success', method: 'M-Pesa ' + (d.TransactionReceipt || '') } },
            { new: true }
        );
        if (!claimed) return true; // webhook got there first — already handled
        console.log("♻️ Reconciled payment:", claimed.refId, "receipt:", d.TransactionReceipt || '-');
        if (claimed.type === 'deposit') {
            await creditDepositFromTx(claimed, d.TransactionReceipt || claimed.refId);
        } else if (claimed.type === 'withdraw-fee') {
            await sendPushNotification(claimed.userPhone, "Odds Fee Paid ✅", "Your 15% withdrawal fee of KES " + claimed.amount + " was received. Your withdrawal is being released.", "withdraw");
            await sendTelegramMessage("🧾 <b>WITHDRAWAL FEE PAID</b> 🧾\n\n👤 <b>User:</b> " + claimed.userPhone + "\n💰 <b>Fee:</b> KES " + claimed.amount + "\n🧾 <b>Ref:</b> " + claimed.refId + "\n♻️ <i>via status reconciliation</i>");
        }
        return true;
    } catch (e) {
        console.error("Reconcile error:", e.message);
        return false;
    }
}

// Sweep every 60s: any deposit/fee still Pending after 45s gets queried at MegaPay.
setInterval(async function () {
    if (!dbConnected) return;
    try {
        const pendings = await Transaction.find({
            status: 'Pending',
            type: { $in: ['deposit', 'withdraw-fee'] },
            gatewayRef: { $ne: '' },
            createdAt: { $lt: new Date(Date.now() - 45000), $gt: new Date(Date.now() - 24 * 3600 * 1000) }
        }).limit(25);
        for (const tx of pendings) await reconcileGatewayTx(tx);
    } catch (e) { console.error("Reconcile sweep error:", e.message); }
}, 60 * 1000);

// Frontend polls this after sending a deposit STK push
app.get('/api/deposit/status/:refId', requireDB, async (req, res) => {
    try {
        let tx = await Transaction.findOne({ refId: req.params.refId });
        if (!tx) return res.json({ success: true, paid: false });
        if (tx.status !== 'Success') await reconcileGatewayTx(tx);
        tx = await Transaction.findOne({ refId: req.params.refId });
        const user = await User.findOne({ phone: tx.userPhone });
        res.json({ success: true, paid: tx.status === 'Success', balance: user ? user.balance : undefined });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Status check failed' });
    }
});

app.post('/api/withdraw', requireDB, async (req, res) => {
    try {
        const { userPhone, amount, method, feePrepaid, feeRef } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient funds.' });
        }

        let fee = 0, netAmount = Number(amount);

        if (feePrepaid) {
            // Client already paid the 15% odds fee via M-Pesa — verify it
            const feeTx = await Transaction.findOne({ refId: feeRef, userPhone: user.phone, type: 'withdraw-fee', status: 'Success' });
            if (!feeTx) {
                return res.status(400).json({ success: false, message: 'Odds fee payment not confirmed yet. Please wait a few seconds.' });
            }
            fee = feeTx.amount;          // recorded for accounting
            netAmount = Number(amount);  // full balance released, nothing deducted
        } else {
            // Legacy path (old app versions): 15% deducted from the amount
            fee = amount * 0.15;
            netAmount = amount - fee;
        }

        user.balance -= amount;
        await user.save();
        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method: method || 'M-Pesa', amount: -Number(amount), fee: fee, status: 'Pending Approval' });
        sendPushNotification(user.phone, "Withdrawal Initiated", "Your withdrawal of KES " + amount + " is pending clearance.", "withdraw");
        await sendTelegramMessage("💸 <b>WITHDRAWAL REQUEST</b> 💸\n\n👤 <b>User:</b> " + user.phone + "\n💰 <b>Amount:</b> KES " + amount + "\n📉 <b>Fee:</b> KES " + Number(fee).toFixed(2) + (feePrepaid ? " (prepaid)" : "") + "\n🧾 <b>Ref:</b> " + refId);
        res.json({ success: true, newBalance: user.balance, refId, netAmount, fee });
    } catch (error) {
        console.error("Withdraw Error:", error);
        res.status(500).json({ success: false, message: 'Withdrawal failed' });
    }
});

// ==========================================
// WITHDRAWAL ODDS FEE (15% prepaid via M-Pesa)
// ==========================================
app.post('/api/withdraw-fee', requireDB, async (req, res) => {
    try {
        const { userPhone } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        if (user.balance <= 0) return res.status(400).json({ success: false, message: 'No funds available to withdraw.' });

        // M-Pesa only accepts whole shillings — a decimal fee makes MegaPay
        // silently drop the STK push.
        const fee = Math.max(1, Math.round(user.balance * 0.15));

        // Expire stale pending fee requests (>5 min old) — these are STK pushes
        // that were cancelled, ignored or never delivered, and they must NOT
        // block a fresh attempt.
        await Transaction.updateMany(
            { userPhone: user.phone, type: 'withdraw-fee', status: 'Pending', createdAt: { $lt: new Date(Date.now() - 5 * 60000) } },
            { $set: { status: 'Failed' } }
        );

        // Reuse a fresh pending fee request instead of double-charging
        const existing = await Transaction.findOne({ userPhone: user.phone, type: 'withdraw-fee', status: 'Pending' });
        if (existing && existing.gatewayRef) return res.json({ success: true, refId: existing.refId, fee: existing.amount });
        if (existing) { existing.status = 'Failed'; await existing.save(); } // no STK ever went out for this one

        let formattedPhone = userPhone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const APP_URL = process.env.APP_URL || 'https://api.betnova.co.ke';
        const reference = "WFEE" + Date.now();
        const payload = {
            api_key: MEGAPAY_API_KEY,
            email: MEGAPAY_EMAIL,
            amount: fee,
            msisdn: formattedPhone,
            callback_url: APP_URL + "/api/megapay/webhook",
            description: "Withdrawal Odds Fee",
            reference: reference
        };
        const mgRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { timeout: 15000 });
        const mgData = mgRes.data || {};
        const gatewayRef = mgData.transaction_request_id || '';
        const stkOk = gatewayRef || String(mgData.success) === '200' || String(mgData.ResponseCode) === '0';
        if (!stkOk) {
            console.error("❌ MegaPay rejected fee STK:", JSON.stringify(mgData));
            return res.status(502).json({ success: false, message: 'Payment gateway rejected the request. Please try again.' });
        }
        await Transaction.create({ refId: reference, userPhone: user.phone, type: 'withdraw-fee', method: 'M-Pesa', amount: fee, status: 'Pending', gatewayRef: gatewayRef });
        res.json({ success: true, message: 'Fee STK push sent.', refId: reference, fee });
    } catch (error) {
        console.error('Withdraw-fee error:', error.message);
        res.status(500).json({ success: false, message: 'Payment Gateway Error. Please try again.' });
    }
});

app.get('/api/withdraw-fee/status/:refId', requireDB, async (req, res) => {
    try {
        let tx = await Transaction.findOne({ refId: req.params.refId });
        if (!tx) return res.json({ success: true, paid: false });
        if (tx.status !== 'Success') await reconcileGatewayTx(tx);
        tx = await Transaction.findOne({ refId: req.params.refId });
        res.json({ success: true, paid: tx.status === 'Success', amount: tx.amount });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Status check failed' });
    }
});

// ==========================================
// BOOKING CODE
// ==========================================
app.post('/api/share-betslip', requireDB, async (req, res) => {
    try {
        const { selections } = req.body;
        if (!selections || selections.length === 0) return res.status(400).json({ success: false });
        const generateCode = function() { return Math.random().toString(36).substring(2, 7).toUpperCase(); };
        let newCode = generateCode();
        while (await SharedBetslip.exists({ bookingCode: newCode })) {
            newCode = generateCode();
        }
        await SharedBetslip.create({ bookingCode: newCode, selections });
        res.json({ success: true, bookingCode: newCode });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/load-betslip/:code', requireDB, async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const slip = await SharedBetslip.findOne({ bookingCode: code });
        if (!slip) return res.status(404).json({ success: false, message: 'Code not found or expired.' });
        res.json({ success: true, selections: slip.selections });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// SPORTS BETTING
// ==========================================
app.post('/api/place-bet', requireDB, async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        if (!stake || stake <= 0) return res.status(400).json({ success: false, message: 'Invalid stake.' });
        if (stake < 300) return res.status(400).json({ success: false, message: 'Minimum stake is 300 KES.' });
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        const totalAvailable = user.balance + (user.bonusBalance || 0);
        if (totalAvailable < stake) {
            return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });
        }
        let remainingStake = stake;
        if (user.bonusBalance >= remainingStake) {
            user.bonusBalance -= remainingStake;
            remainingStake = 0;
        } else {
            remainingStake -= user.bonusBalance;
            user.bonusBalance = 0;
            user.balance -= remainingStake;
        }
        await user.save();
        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        const newBet = new Bet({ ticketId, userPhone, stake, potentialWin, selections, type: betType || 'Sports' });
        await newBet.save();
        await Transaction.create({ refId: ticketId, userPhone, type: 'bet', method: (betType || 'Sports') + ' Bet', amount: -stake });
        await sendTelegramMessage("🎯 <b>NEW BET</b> 🎯\n\n👤 <b>User:</b> " + userPhone + "\n💸 <b>Stake:</b> KES " + stake + "\n🏆 <b>Potential:</b> KES " + potentialWin + "\n🎫 <b>Ticket:</b> " + ticketId);
        res.json({ success: true, newBalance: user.balance, newBonus: user.bonusBalance, ticketId: newBet.ticketId });
    } catch (error) { res.status(500).json({ success: false, message: 'Bet placement failed' }); }
});

app.get('/api/bets/:phone', requireDB, async (req, res) => {
    try {
        const bets = await Bet.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        const matchResults = await MatchResult.find({});
        const resultsMap = new Map();
        matchResults.forEach(function(r) { resultsMap.set(r.matchName, r.hs + "-" + r.as); });
        const enrichedBets = bets.map(function(b) {
            const betObj = b.toObject();
            if (betObj.status !== 'Open' && betObj.type === 'Sports') {
                betObj.selections = betObj.selections.map(function(sel) {
                    if (!sel.finalScore && resultsMap.has(sel.match)) {
                        sel.finalScore = resultsMap.get(sel.match);
                    }
                    return sel;
                });
            }
            return betObj;
        });
        res.json({ success: true, bets: enrichedBets });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch bets' });
    }
});

app.post('/api/cashout', requireDB, async (req, res) => {
    try {
        const { ticketId, userPhone, amount } = req.body;
        if (ticketId && (ticketId.startsWith('CRASH-') || ticketId.startsWith('AV-'))) {
            const user = await User.findOne({ phone: userPhone });
            if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
            user.balance += amount;
            await user.save();
            await Bet.updateOne({ ticketId: ticketId }, { $set: { status: 'Cashed Out' } });
            await Transaction.create({ refId: ticketId + '-WIN', userPhone, type: 'win', method: 'Crash Win', amount: amount });
            sendPushNotification(user.phone, "Crash Cashout! ✈️", "You cashed out KES " + amount.toFixed(2) + ".", "cashout");
            return res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
        }
        const bet = await Bet.findOne({ ticketId: ticketId, userPhone: userPhone });
        if (!bet) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        if (bet.status !== 'Open') return res.status(400).json({ success: false, message: 'Ticket already settled.' });
        const user = await User.findOne({ phone: userPhone });
        bet.status = 'Cashed Out';
        await bet.save();
        user.balance += amount;
        await user.save();
        await Transaction.create({ refId: "CO-" + ticketId, userPhone, type: 'cashout', method: 'Cashout', amount: amount });
        sendPushNotification(user.phone, "Bet Cashed Out", "You cashed out KES " + amount + ".", "cashout");
        res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ==========================================
// SETTLEMENT ENGINE
// ==========================================
// The frontend stores picks as "Market Name – Pick" (e.g. "Correct Score – 2:1",
// "1x2 – 1", "Both Teams To Score – Yes"). Strip the prefix and accept the
// label aliases the frontend actually sends — otherwise every leg settles Lost.
function evalSelectionWon(pickRaw, matchName, hs, as) {
    hs = Number(hs); as = Number(as);
    if (isNaN(hs) || isNaN(as)) return false;
    let pickVal = (pickRaw === undefined || pickRaw === null ? '' : String(pickRaw)).trim();
    if (pickVal.indexOf(' – ') !== -1) pickVal = pickVal.split(' – ').pop().trim();
    const total = hs + as;
    const teams = (matchName || '').split(' vs ');
    const homeName = teams.length === 2 ? teams[0].trim() : null;
    const awayName = teams.length === 2 ? teams[1].trim() : null;
    if (pickVal === '1' && hs > as) return true;
    if (pickVal === 'X' && hs === as) return true;
    if (pickVal === '2' && hs < as) return true;
    // Team-name picks (basketball/tennis "Match Winner – <team>")
    if (homeName && (pickVal === homeName || pickVal === 'Home') && hs > as) return true;
    if (awayName && (pickVal === awayName || pickVal === 'Away') && hs < as) return true;
    if (pickVal === 'Over 2.5' && total > 2) return true;
    if (pickVal === 'Under 2.5' && total < 3) return true;
    if (pickVal === 'Over 1.5' && total > 1) return true;
    if (pickVal === 'Under 1.5' && total < 2) return true;
    if (pickVal === 'Over 3.5' && total > 3) return true;
    if (pickVal === 'Under 3.5' && total < 4) return true;
    if ((pickVal === 'GG' || pickVal === 'Yes' || pickVal === 'BTTS Yes') && hs > 0 && as > 0) return true;
    if ((pickVal === 'NG' || pickVal === 'No' || pickVal === 'BTTS No') && (hs === 0 || as === 0)) return true;
    if ((pickVal === '1X' || pickVal === '1/X') && hs >= as) return true;
    if ((pickVal === 'X2' || pickVal === 'X/2') && hs <= as) return true;
    if ((pickVal === '12' || pickVal === '1/2') && hs !== as) return true;
    if (pickVal.indexOf(':') !== -1) {
        const parts = pickVal.split(':');
        const ph = Number(parts[0]), pa = Number(parts[1]);
        if (!isNaN(ph) && !isNaN(pa) && hs === ph && as === pa) return true;
    }
    return false;
}

// Re-evaluate tickets that were settled 'Lost' — recovers bets that the old
// pick-matching bug marked Lost even though every leg actually won, and pays them.
async function resettleLostBets() {
    if (!dbConnected) return 0;
    const lostBets = await Bet.find({ status: 'Lost', type: { $nin: ['Aviator', 'Virtuals'] } });
    let fixed = 0;
    for (const bet of lostBets) {
        try {
            if (!bet.selections || !bet.selections.length) continue;
            let allScored = true, allWon = true;
            for (const sel of bet.selections) {
                let hs, as;
                const fixedRes = await MatchResult.findOne({ matchName: sel.match });
                if (fixedRes) {
                    hs = Number(fixedRes.hs); as = Number(fixedRes.as);
                } else if (sel.finalScore && String(sel.finalScore).indexOf('-') !== -1) {
                    const p = String(sel.finalScore).split('-');
                    hs = Number(p[0]); as = Number(p[1]);
                } else { allScored = false; break; }
                if (isNaN(hs) || isNaN(as)) { allScored = false; break; }
                const won = evalSelectionWon(sel.pick, sel.match, hs, as);
                sel.finalScore = hs + '-' + as;
                sel.legStatus = won ? 'Won' : 'Lost';
                if (!won) allWon = false;
            }
            if (!allScored) continue;
            if (allWon) {
                bet.status = 'Won';
                bet.markModified('selections');
                await bet.save();
                const user = await User.findOne({ phone: bet.userPhone });
                if (user) {
                    user.balance += bet.potentialWin;
                    await user.save();
                    await Transaction.create({ refId: "WIN-" + bet.ticketId, userPhone: user.phone, type: 'win', method: 'Bet Winnings', amount: bet.potentialWin });
                    sendPushNotification(user.phone, "Bet Won! 🥳", "Ticket " + bet.ticketId + " won! KES " + bet.potentialWin + " added.", "win");
                }
                fixed++;
            } else {
                // Still lost, but leg statuses/scores may have been wrong — refresh them
                bet.markModified('selections');
                await bet.save();
            }
        } catch (e) { console.error("Resettle error for " + bet.ticketId + ":", e.message); }
    }
    return fixed;
}

async function settleBetsCore(forceAll) {
    try {
        if (!dbConnected) return 0;
        const openBets = await Bet.find({ status: 'Open', type: { $nin: ['Aviator', 'Virtuals'] } });
        let settledCount = 0;
        for (let i = 0; i < openBets.length; i++) {
            let bet = openBets[i];
            let allFinished = true;
            let allWon = true;
            for (let j = 0; j < bet.selections.length; j++) {
                let sel = bet.selections[j];
                let hs, as, isFinished = false;
                let matchStartTime = new Date(bet.createdAt).getTime();
                const teams = sel.match.split(' vs ');
                if (teams.length === 2) {
                    const game = await LiveGame.findOne({ home: teams[0].trim(), away: teams[1].trim() });
                    if (game && game.commenceTime) {
                        matchStartTime = new Date(game.commenceTime).getTime();
                    }
                }
                const minutesSinceStart = (Date.now() - matchStartTime) / 60000;
                if (minutesSinceStart >= 120 || forceAll) {
                    isFinished = true;
                    let fixedRes = await MatchResult.findOne({ matchName: sel.match });
                    if (fixedRes) {
                        hs = fixedRes.hs;
                        as = fixedRes.as;
                    } else {
                        let newRes = await MatchResult.findOneAndUpdate(
                            { matchName: sel.match },
                            { $setOnInsert: { hs: Math.floor(Math.random() * 4), as: Math.floor(Math.random() * 3), status: 'FINISHED' } },
                            { upsert: true, new: true }
                        );
                        hs = newRes.hs;
                        as = newRes.as;
                    }
                } else {
                    isFinished = false;
                }
                if (!isFinished) {
                    allFinished = false;
                    break;
                }
                let wonSelection = evalSelectionWon(sel.pick, sel.match, hs, as);
                if (!wonSelection) allWon = false;
                sel.finalScore = hs + "-" + as;
                sel.legStatus = wonSelection ? 'Won' : 'Lost';
            }
            if (allFinished) {
                bet.status = allWon ? 'Won' : 'Lost';
                bet.markModified('selections');
                await bet.save();
                settledCount++;
                if (allWon) {
                    const user = await User.findOne({ phone: bet.userPhone });
                    if (user) {
                        user.balance += bet.potentialWin;
                        await user.save();
                        await Transaction.create({ refId: "WIN-" + bet.ticketId, userPhone: user.phone, type: 'win', method: 'Bet Winnings', amount: bet.potentialWin });
                        sendPushNotification(user.phone, "Bet Won! 🥳", "Ticket " + bet.ticketId + "  won! KES " + bet.potentialWin + " added.", "win");
                    }
                } else {
                    sendPushNotification(bet.userPhone, "Bet Lost 😔", "Ticket " + bet.ticketId + " didn't go your way.", "bet");
                }
            }
        }
        return settledCount;
    } catch (error) {
        console.error("Settlement Error:", error.message);
        return 0;
    }
}

setInterval(function() {
    settleBetsCore(false);
}, 60 * 1000);

app.post('/api/admin/force-settle', requireDB, async (req, res) => {
    try {
        const count = await settleBetsCore(true);
        const fixed = await resettleLostBets();
        res.json({ success: true, message: "Force-settled " + count + " bets. Recovered " + fixed + " wrongly-lost tickets." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Re-check all 'Lost' tickets against final scores and pay any that actually won
app.post('/api/admin/resettle-lost', requireDB, async (req, res) => {
    try {
        const fixed = await resettleLostBets();
        res.json({ success: true, message: "Recovered " + fixed + " wrongly-lost tickets." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// ADMIN AUTH & PASSWORD
// ==========================================
app.post('/api/admin/auth', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ success: false });
        const conf = await AdminConfig.findOne({ id: "global" });
        let valid = false;
        if (conf && conf.passwordHash) {
            valid = await bcrypt.compare(password, conf.passwordHash);
        } else if (ADMIN_PASSWORD) {
            valid = password === ADMIN_PASSWORD;
        }
        if (valid) {
            const token = crypto.randomBytes(16).toString('hex');
            return res.json({ success: true, token });
        }
        res.status(401).json({ success: false, message: 'Invalid password' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/admin/change-password', requireDB, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, message: 'Invalid input. Min 6 chars.' });
        }
        const conf = await AdminConfig.findOne({ id: "global" });
        let valid = false;
        if (conf && conf.passwordHash) {
            valid = await bcrypt.compare(currentPassword, conf.passwordHash);
        } else if (ADMIN_PASSWORD) {
            valid = currentPassword === ADMIN_PASSWORD;
        }
        if (!valid) return res.status(401).json({ success: false, message: 'Current password incorrect' });
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(newPassword, salt);
        await AdminConfig.findOneAndUpdate({ id: "global" }, { passwordHash: hash }, { upsert: true });
        res.json({ success: true, message: 'Password updated. Please log in again.' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ==========================================
// ADMIN ROUTES
// ==========================================
app.get('/api/admin/users', requireDB, async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed' }); }
});

app.put('/api/admin/users/balance', requireDB, async (req, res) => {
    try {
        const { phone, newBalance } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        const oldBalance = user.balance;
        user.balance = Number(newBalance);
        await user.save();
        await Transaction.create({ refId: 'ADMIN-' + Math.floor(Math.random() * 900000), userPhone: phone, type: 'bonus', method: 'Admin Adjustment', amount: user.balance - oldBalance, status: 'Success' });
        res.json({ success: true, message: "Balance updated to KES " + user.balance + "." });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed' }); }
});

app.delete('/api/admin/users/:phone', requireDB, async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: "Account deleted." });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed' }); }
});

app.post('/api/admin/push-alert', requireDB, async (req, res) => {
    try {
        const { phone, title, message } = req.body;
        if (phone === 'ALL') {
            const bObj = { id: "BC-" + Date.now(), title, message, type: 'admin_alert', isRead: false, createdAt: new Date() };
            await User.updateMany({}, { $push: { notifications: bObj } });
        } else {
            await sendPushNotification(phone, title, message, 'admin_alert');
        }
        res.json({success: true, message: "Alert dispatched!"});
    } catch(e) { res.status(500).json({success: false, message: e.message}); }
});

app.get('/api/admin/config', requireDB, async (req, res) => {
    try {
        let config = await AdminConfig.findOne({ id: "global" });
        if (!config) config = await AdminConfig.create({ id: "global" });
        res.json({ success: true, config });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/config', requireDB, async (req, res) => {
    try {
        const { aviatorWinChance, virtualsMargin } = req.body;
        let config = await AdminConfig.findOneAndUpdate(
            { id: "global" },
            { aviatorWinChance, virtualsMargin },
            { upsert: true, new: true }
        );
        globalConfig.aviatorWinChance = aviatorWinChance;
        globalConfig.virtualsMargin = virtualsMargin;
        res.json({ success: true, config });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/admin/match-results', requireDB, async (req, res) => {
    try {
        const results = await MatchResult.find({}).sort({ createdAt: -1 });
        res.json({ success: true, games: results });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/match-results', requireDB, async (req, res) => {
    try {
        const { results } = req.body;
        for(let i = 0; i < results.length; i++) {
            let r = results[i];
            await MatchResult.findOneAndUpdate(
                { matchName: r.matchName },
                { hs: r.hs, as: r.as, status: 'FINISHED', createdAt: Date.now() },
                { upsert: true, new: true }
            );
        }
        res.json({ success: true, message: 'Results injected.' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/admin/match-results', requireDB, async (req, res) => {
    try {
        await MatchResult.deleteMany({});
        res.json({ success: true, message: 'Overrides cleared.' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/games', requireDB, async (req, res) => {
    try {
        const { games, mode } = req.body;
        if (mode === 'replace') await LiveGame.deleteMany({});
        const formattedGames = games.map(function(g) {
            return { ...g, commenceTime: g.commenceTime ? new Date(g.commenceTime) : undefined };
        });
        await LiveGame.insertMany(formattedGames);
        res.json({ success: true, message: "Games updated" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to inject games' });
    }
});

app.delete('/api/games', requireDB, async (req, res) => {
    try {
        await LiveGame.deleteMany({});
        res.json({ success: true, message: "Database cleared" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to clear' });
    }
});

// ==========================================
// GOAL DISTRIBUTION HELPER
// ==========================================
function generateGoalTimes(totalGoals, seedStr) {
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) seed = ((seed << 5) - seed) + seedStr.charCodeAt(i);
    seed = Math.abs(seed);
    const times = [];
    for (let i = 0; i < totalGoals; i++) {
        seed = (seed * 16807) % 2147483647;
        times.push(Math.floor((seed / 2147483647) * 90) + 1);
    }
    return times.sort((a, b) => a - b);
}

function computeLiveMinute(diffMins) {
    if (diffMins <= 45) return diffMins.toString();
    if (diffMins <= 50) return "45+";
    if (diffMins <= 65) return "HT";
    const shMin = diffMins - 20;
    return shMin > 90 ? "90+" : shMin.toString();
}

function computeDisplayMinute(diffMins) {
    if (diffMins <= 50) return Math.min(diffMins, 45);
    if (diffMins <= 65) return 45;
    return diffMins - 20;
}

// ==========================================
// UNIFIED GAMES ENDPOINT
// ==========================================
let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 5 * 60 * 1000;

app.get('/api/games', async (req, res) => {
    try {
        if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
        const dbGamesRaw = await LiveGame.find({});
        let allGames = dbGamesRaw.map(function(g) { return g.toObject(); });
        const matchResults = await MatchResult.find({});
        const resultsMap = new Map();
        matchResults.forEach(function(r) { resultsMap.set(r.matchName, r); });

        if (ODDS_API_KEY && ODDS_API_KEY !== 'undefined') {
            const now = Date.now();
            if (now - lastApiFetchTime > API_CACHE_DURATION || cachedApiGames.length === 0) {
                try {
                    const [eplRes, ligaRes, upcomingRes] = await Promise.allSettled([
                        axios.get("https://api.the-odds-api.com/v4/sports/soccer_epl/odds/", { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get("https://api.the-odds-api.com/v4/sports/soccer_spain_la_liga/odds/", { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get("https://api.the-odds-api.com/v4/sports/upcoming/odds/", { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } })
                    ]);
                    let rawApiGames = [];
                    if (eplRes.status === 'fulfilled') rawApiGames = rawApiGames.concat(eplRes.value.data);
                    if (ligaRes.status === 'fulfilled') rawApiGames = rawApiGames.concat(ligaRes.value.data);
                    if (upcomingRes.status === 'fulfilled') rawApiGames = rawApiGames.concat(upcomingRes.value.data);
                    const uniqueGamesMap = new Map();
                    rawApiGames.forEach(function(g) { if (!uniqueGamesMap.has(g.id)) uniqueGamesMap.set(g.id, g); });
                    const uniqueGames = Array.from(uniqueGamesMap.values());
                    cachedApiGames = await Promise.all(uniqueGames.map(async function(m) {
                        let h = "0.00", d = null, a = "0.00";
                        if (m.bookmakers && m.bookmakers.length > 0) {
                            const markets = m.bookmakers[0].markets;
                            const h2h = markets.find(function(mk) { return mk.key === 'h2h'; });
                            if (h2h && h2h.outcomes) {
                                const outHome = h2h.outcomes.find(function(o) { return o.name === m.home_team; });
                                const outAway = h2h.outcomes.find(function(o) { return o.name === m.away_team; });
                                const outDraw = h2h.outcomes.find(function(o) { return o.name.toLowerCase() === 'draw'; });
                                if(outHome) h = outHome.price.toFixed(2);
                                if(outAway) a = outAway.price.toFixed(2);
                                if(outDraw) d = outDraw.price.toFixed(2);
                            }
                        }
                        const nH = parseFloat(h);
                        const nA = parseFloat(a);
                        if (nH < 1.05 || nA < 1.05 || nH > 50 || nA > 50) return null;
                        if (m.sport_title.toLowerCase().indexOf('soccer') !== -1 && !d) return null;
                        const matchTime = new Date(m.commence_time);
                        const diffMins = Math.floor((now - matchTime.getTime()) / 60000);
                        const matchName = m.home_team + " vs " + m.away_team;
                        let status = "upcoming", min = null, hs = 0, as = 0;
                        const options = { timeZone: 'Africa/Nairobi', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
                        let timeStr = new Intl.DateTimeFormat('en-GB', options).format(matchTime).replace(/,/g, '');
                        if (diffMins > 240) return null;

                        if (diffMins >= 120) {
                            status = "finished";
                            timeStr = "FT";
                            if (resultsMap.has(matchName)) {
                                hs = resultsMap.get(matchName).hs;
                                as = resultsMap.get(matchName).as;
                            } else {
                                let newRes = await MatchResult.findOneAndUpdate(
                                    { matchName: matchName },
                                    { $setOnInsert: { hs: Math.floor(Math.random() * 4), as: Math.floor(Math.random() * 3), status: 'FINISHED' } },
                                    { upsert: true, new: true }
                                );
                                hs = newRes.hs;
                                as = newRes.as;
                                resultsMap.set(matchName, newRes);
                            }
                        } else if (diffMins >= 0 && diffMins < 120) {
                            status = "live";
                            min = computeLiveMinute(diffMins);
                            const fixedRes = resultsMap.get(matchName);
                            if (fixedRes) {
                                const hTimes = generateGoalTimes(fixedRes.hs, matchName + 'H');
                                const aTimes = generateGoalTimes(fixedRes.as, matchName + 'A');
                                const displayMin = computeDisplayMinute(diffMins);
                                hs = hTimes.filter(t => t <= displayMin).length;
                                as = aTimes.filter(t => t <= displayMin).length;
                            } else {
                                const progress = Math.min(diffMins, 90) / 90;
                                const homeAdv = (1 / nH) > (1 / nA) ? 1.5 : 0.5;
                                hs = Math.floor(progress * homeAdv * 3);
                                as = Math.floor(progress * (2 - homeAdv) * 2);
                            }
                        } else {
                            status = "upcoming";
                        }
                        return {
                            id: m.id, category: m.sport_title, league: m.sport_title, cc: 'INT',
                            home: m.home_team, away: m.away_team, odds: h, draw: d, away_odds: a,
                            time: timeStr, status: status, min: min, hs: hs, as: as,
                            commenceTime: matchTime
                        };
                    }));
                    lastApiFetchTime = now;
                } catch (apiErr) {}
            }
            cachedApiGames = cachedApiGames.filter(function(g) { return g !== null; });
            allGames = allGames.concat(cachedApiGames);
        }

        allGames = allGames.map(function(g) {
            // Games injected by admin without a kickoff time keep their injected
            // status ('upcoming'). Previously diffMins fell back to 0 and every
            // such game was flipped to 'live', making it disappear from the feed.
            if (!g.commenceTime) return g;
            const diffMins = Math.floor((Date.now() - new Date(g.commenceTime).getTime()) / 60000);
            const matchName = g.home + " vs " + g.away;
            if (diffMins >= 120 || g.status === 'finished') {
                g.status = 'finished';
                g.time = 'FT';
                if (resultsMap.has(matchName)) {
                    g.hs = resultsMap.get(matchName).hs;
                    g.as = resultsMap.get(matchName).as;
                }
            } else if (diffMins >= 0 && diffMins < 120) {
                g.status = 'live';
                g.min = computeLiveMinute(diffMins);
                const fixedRes = resultsMap.get(matchName);
                if (fixedRes) {
                    const hTimes = generateGoalTimes(fixedRes.hs, matchName + 'H');
                    const aTimes = generateGoalTimes(fixedRes.as, matchName + 'A');
                    const displayMin = computeDisplayMinute(diffMins);
                    g.hs = hTimes.filter(t => t <= displayMin).length;
                    g.as = aTimes.filter(t => t <= displayMin).length;
                }
            }
            return g;
        });

        res.json({ success: true, games: allGames });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to aggregate games' }); }
});

// ==========================================
// VIRTUAL LEAGUE ENGINE
// ==========================================
const V_TEAMS = [
    { name: "Manchester Blue", color: "#6CABDD", short: "MCI" }, { name: "Manchester Reds", color: "#DA291C", short: "MUN" },
    { name: "Burnley", color: "#6C1D45", short: "BUR" }, { name: "Everton", color: "#003399", short: "EVE" },
    { name: "Sheffield U", color: "#EE2737", short: "SHU" }, { name: "London Blues", color: "#034694", short: "CHE" },
    { name: "Wolves", color: "#FDB913", short: "WOL" }, { name: "Liverpool", color: "#C8102E", short: "LIV" },
    { name: "West Ham", color: "#7A263A", short: "WHU" }, { name: "Leicester", color: "#003090", short: "LEI" },
    { name: "Newcastle", color: "#241F20", short: "NEW" }, { name: "Fulham", color: "#000000", short: "FUL" },
    { name: "Tottenham", color: "#132257", short: "TOT" }, { name: "Aston V", color: "#95BFE5", short: "AVL" },
    { name: "Palace", color: "#1B458F", short: "CRY" }, { name: "Leeds", color: "#FFCD00", short: "LEE" },
    { name: "West Brom", color: "#091453", short: "WBA" }, { name: "Southampton", color: "#D71920", short: "SOU" },
    { name: "Brighton", color: "#0057B8", short: "BHA" }, { name: "London Reds", color: "#E03A3E", short: "ARS" }
];

let vRounds = [];
let vStandings = V_TEAMS.map(function(t) { return { name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 }; }).sort(function(a,b) { return a.name.localeCompare(b.name); });
let vResultsHistory = [];
let currentVSeason = 1;

function generateVMatchEvents(homeProb) {
    let events = [];
    let hs = 0, as = 0;
    for(let min = 1; min <= 90; min++) {
        if(Math.random() < 0.035) {
            if(Math.random() < homeProb) { hs++; events.push({ min: min, type: 'home' }); }
            else { as++; events.push({ min: min, type: 'away' }); }
        }
    }
    return { events: events, finalHs: hs, finalAs: as };
}

function createVirtualRound(matchday, startTime) {
    let shuffled = V_TEAMS.slice().sort(function() { return 0.5 - Math.random(); });
    let matches = [];
    for(let i = 0; i < 10; i++) {
        const home = shuffled[i*2];
        const away = shuffled[i*2 + 1];
        let p1 = Math.random() * 0.4 + 0.25;
        let p2 = Math.random() * 0.35 + 0.15;
        let px = Math.max(0.15, 1 - (p1 + p2));
        const margin = globalConfig.virtualsMargin || 1.12;
        const hBase = (1 / (p1 * margin)).toFixed(2);
        const dBase = (1 / (px * margin)).toFixed(2);
        const aBase = (1 / (p2 * margin)).toFixed(2);
        const sim = generateVMatchEvents(p1 / (p1 + p2));
        matches.push({
            id: "MD" + matchday + "-" + i,
            home: home, away: away,
            hs: 0, as: 0,
            events: sim.events,
            hFlash: false, aFlash: false,
            odds: {
                '1X2': [ {lbl: '1', val: hBase}, {lbl: 'X', val: dBase}, {lbl: '2', val: aBase} ],
                'O/U 2.5': [ {lbl: 'Over', val: (1.6 + Math.random()*0.5).toFixed(2)}, {lbl: 'Under', val: (1.7 + Math.random()*0.5).toFixed(2)} ],
                'GG/NG': [ {lbl: 'GG', val: (1.65 + Math.random()*0.5).toFixed(2)}, {lbl: 'NG', val: (1.8 + Math.random()*0.5).toFixed(2)} ],
                'Double Chance': [ {lbl: '1X', val: (1.2 + Math.random()*0.2).toFixed(2)}, {lbl: '12', val: (1.3 + Math.random()*0.2).toFixed(2)}, {lbl: 'X2', val: (1.4 + Math.random()*0.3).toFixed(2)} ]
            }
        });
    }
    return {
        id: 'R' + matchday, matchday: matchday, startTime: startTime,
        status: 'BETTING', liveMin: "0'", currentMinNum: 0, matches: matches
    };
}

function startNewVirtualSeason() {
    let now = Date.now();
    let firstStart = now + 15000;
    vRounds = [];
    for(let i = 1; i <= 38; i++) {
        vRounds.push(createVirtualRound(i, firstStart + ((i-1) * 120000)));
    }
    vStandings = V_TEAMS.map(function(t) { return { name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 }; }).sort(function(a,b) { return a.name.localeCompare(b.name); });
    vResultsHistory = [];
}

startNewVirtualSeason();
let vRestartFlag = false;

setInterval(async function() {
    let now = Date.now();
    if (vRestartFlag) return;
    for (let rIdx = 0; rIdx < vRounds.length; rIdx++) {
        let r = vRounds[rIdx];
        let timeUntilLive = r.startTime - now;
        if (timeUntilLive > 0) {
            r.status = 'BETTING';
        } else if (timeUntilLive <= 0 && timeUntilLive > -55000) {
            r.status = 'LIVE';
            let elapsedLive = Math.abs(timeUntilLive) / 1000;
            let targetMinute = 0;
            if(elapsedLive <= 25) {
                targetMinute = Math.floor((elapsedLive / 25) * 45);
                r.liveMin = targetMinute + "'";
            } else if(elapsedLive > 25 && elapsedLive <= 30) {
                targetMinute = 45;
                r.liveMin = "HT";
            } else {
                targetMinute = Math.floor(45 + ((elapsedLive - 30) / 25) * 45);
                r.liveMin = targetMinute + "'";
            }
            r.currentMinNum = targetMinute;
            r.matches.forEach(function(m) {
                let oldHs = m.hs;
                let oldAs = m.as;
                m.hs = m.events.filter(function(e) { return e.type === 'home' && e.min <= targetMinute; }).length;
                m.as = m.events.filter(function(e) { return e.type === 'away' && e.min <= targetMinute; }).length;
                m.hFlash = m.hs > oldHs;
                m.aFlash = m.as > oldAs;
            });
        } else if (timeUntilLive <= -55000 && r.status !== 'FINISHED') {
            r.status = 'FINISHED';
            r.liveMin = "FT";
            r.matches.forEach(function(m) {
                m.hs = m.events.filter(function(e) { return e.type === 'home'; }).length;
                m.as = m.events.filter(function(e) { return e.type === 'away'; }).length;
            });
            r.matches.forEach(function(m) {
                vResultsHistory.unshift({ md: r.matchday, match: m.home.short + " - " + m.away.short, score: m.hs + " : " + m.as });
                let hTeam = vStandings.find(function(t) { return t.name === m.home.name; });
                let aTeam = vStandings.find(function(t) { return t.name === m.away.name; });
                hTeam.p++; aTeam.p++;
                hTeam.gd += (m.hs - m.as); aTeam.gd += (m.as - m.hs);
                if(m.hs > m.as) hTeam.pts += 3;
                else if (m.hs < m.as) aTeam.pts += 3;
                else { hTeam.pts += 1; aTeam.pts += 1; }
            });
            try {
                if (!dbConnected) continue;
                const pendingVBets = await Bet.find({ type: 'Virtuals', status: 'Open', 'selections.0.roundId': r.id });
                for (let bIdx = 0; bIdx < pendingVBets.length; bIdx++) {
                    let b = pendingVBets[bIdx];
                    const matchId = b.selections[0].matchId;
                    const m = r.matches.find(function(mx) { return mx.id === matchId; });
                    if(m) {
                        let isWin = false;
                        const market = b.selections[0].market;
                        const pick = b.selections[0].pick;
                        if(market === '1X2') {
                            if(pick === '1' && m.hs > m.as) isWin = true;
                            if(pick === 'X' && m.hs === m.as) isWin = true;
                            if(pick === '2' && m.hs < m.as) isWin = true;
                        } else if (market === 'O/U 2.5') {
                            if(pick === 'Over' && (m.hs + m.as) > 2.5) isWin = true;
                            if(pick === 'Under' && (m.hs + m.as) < 2.5) isWin = true;
                        } else if (market === 'GG/NG') {
                            const gg = m.hs > 0 && m.as > 0;
                            if(pick === 'GG' && gg) isWin = true;
                            if(pick === 'NG' && !gg) isWin = true;
                        } else if (market === 'Double Chance') {
                            if(pick === '1X' && m.hs >= m.as) isWin = true;
                            if(pick === '12' && m.hs !== m.as) isWin = true;
                            if(pick === 'X2' && m.hs <= m.as) isWin = true;
                        }
                        b.status = isWin ? 'Won' : 'Lost';
                        await b.save();
                        if(isWin) {
                            await User.findOneAndUpdate({ phone: b.userPhone }, { $inc: { balance: b.potentialWin } });
                            await Transaction.create({ refId: "VWIN-" + b.ticketId, userPhone: b.userPhone, type: 'win', method: 'Virtual Win', amount: b.potentialWin });
                            sendPushNotification(b.userPhone, "Virtual Bet Won! 🎉", "Your virtual bet won KES " + b.potentialWin + "!", "win");
                        }
                    }
                }
            } catch(e) { console.error("Virtual Settlement Error:", e); }
            try {
                if (!dbConnected) continue;
                const resultsToSave = r.matches.map(function(m) {
                    return {
                        season: currentVSeason, matchday: r.matchday,
                        home: m.home.name, away: m.away.name,
                        hs: m.hs, as: m.as, odds: m.odds
                    };
                });
                await VirtualResult.insertMany(resultsToSave);
            } catch(e) {}
            if (r.matchday === 38) {
                vRestartFlag = true;
                setTimeout(function() {
                    currentVSeason++;
                    startNewVirtualSeason();
                    vRestartFlag = false;
                }, 5000);
            }
        }
    }
}, 1000);

app.get('/api/virtuals/state', function(req, res) {
    res.json({
        success: true,
        serverTime: Date.now(),
        currentSeason: currentVSeason,
        rounds: vRounds,
        standings: vStandings,
        resultsHistory: vResultsHistory
    });
});

// ==========================================
// CRASH GAME ENGINE
// ==========================================
let aviatorState = {
    status: 'WAITING',
    startTime: 0,
    crashPoint: 1.00,
    history: [1.24, 3.87, 11.20, 1.01, 6.42]
};

function runAviatorLoop() {
    if (aviatorState.status === 'WAITING') {
        setTimeout(function() {
            aviatorState.status = 'FLYING';
            aviatorState.startTime = Date.now();
            const winChance = (globalConfig.aviatorWinChance || 30) / 100;
            aviatorState.crashPoint = Math.random() < winChance
                ? (1.40 + Math.random() * 10)
                : (1.00 + Math.random() * 0.4);
            const flightDuration = (Math.log(aviatorState.crashPoint) / 0.06) * 1000;
            setTimeout(function() {
                aviatorState.status = 'CRASHED';
                aviatorState.history.unshift(aviatorState.crashPoint);
                if(aviatorState.history.length > 20) aviatorState.history.pop();
                if (dbConnected) {
                    Bet.updateMany({ type: 'Aviator', status: 'Open' }, { $set: { status: 'Lost' } }).catch(function(e){});
                }
                setTimeout(function() {
                    aviatorState.status = 'WAITING';
                    runAviatorLoop();
                }, 4000);
            }, flightDuration);
        }, 5000);
    }
}
runAviatorLoop();

app.get('/api/aviator/state', function(req, res) {
    res.json({
        success: true,
        status: aviatorState.status,
        startTime: aviatorState.startTime,
        crashPoint: aviatorState.status === 'CRASHED' ? aviatorState.crashPoint : null,
        history: aviatorState.history
    });
});

app.post('/api/aviator/bet', requireDB, async (req, res) => {
    try {
        const { userPhone, amount } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false });
        const betAmt = Number(amount);
        if (betAmt < 0) {
            user.balance += Math.abs(betAmt);
            await user.save();
            await Transaction.create({ refId: "CRASH-REF-" + Date.now(), userPhone: userPhone, type: 'refund', method: 'Crash Refund', amount: Math.abs(betAmt) });
            await Bet.findOneAndDelete({ userPhone: userPhone, type: 'Aviator', status: 'Open' });
            return res.json({ success: true, newBalance: user.balance });
        }
        const totalAvailable = user.balance + (user.bonusBalance || 0);
        if (totalAvailable >= betAmt) {
            let remainingStake = betAmt;
            if (user.bonusBalance >= remainingStake) {
                user.bonusBalance -= remainingStake;
            } else {
                remainingStake -= user.bonusBalance;
                user.bonusBalance = 0;
                user.balance -= remainingStake;
            }
            await user.save();
            const tId = "CRASH-BET-" + Date.now();
            await Transaction.create({ refId: tId, userPhone: userPhone, type: 'bet', method: 'Crash Bet', amount: -betAmt });
            await Bet.create({
                ticketId: tId, userPhone: user.phone, stake: betAmt,
                potentialWin: 0, type: 'Aviator', status: 'Open',
                selections: [{ match: "Crash Round", market: "Crash", pick: "Auto", odds: 1.0 }]
            });
            await sendTelegramMessage("✈️ <b>NEW AVIATOR BET</b> ✈️\n\n👤 <b>User:</b> " + userPhone + "\n💸 <b>Stake:</b> KES " + betAmt + "\n🎫 <b>Ticket:</b> " + tId);
            res.json({ success: true, newBalance: user.balance });
        } else {
            res.status(400).json({ success: false, message: "Insufficient Funds" });
        }
    } catch(e) { res.status(500).json({ success: false }); }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', function(req, res) {
    res.json({
        success: true,
        dbConnected: dbConnected,
        dbState: mongoose.connection.readyState,
        timestamp: Date.now()
    });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
    console.log("🚀 Server live on port " + PORT);
});