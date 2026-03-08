require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); 
const http = require('http'); // Required for Socket.io
const { Server } = require('socket.io'); // Import Socket.io

const app = express();
const server = http.createServer(app); // Wrap express in HTTP server

// ==========================================
// CORS & SOCKET CONFIGURATION
// ==========================================
app.use(cors({
    origin: "*", // 🟢 ALLOWS ALL CONNECTIONS
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: false 
}));

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const ODDS_API_KEY = process.env.ODDS_API_KEY; // 🟢 FIXED: Required for the games endpoint

// ==========================================
// REAL-TIME SOCKET HANDLER
// ==========================================
const activeSockets = {}; // Maps phone numbers to socket IDs

io.on('connection', (socket) => {
    // Register user phone to target specific notifications
    socket.on('register_user', (phone) => {
        if(phone) {
            activeSockets[phone] = socket.id;
            console.log(`User ${phone} connected to socket`);
        }
    });

    // Join specific chat room for live support
    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
    });

    socket.on('disconnect', () => {
        for (let phone in activeSockets) {
            if (activeSockets[phone] === socket.id) delete activeSockets[phone];
        }
    });
});

// Helper function to send instant alerts to specific users
function sendPushNotification(phone, title, message, type) {
    const socketId = activeSockets[phone];
    if (socketId) {
        io.to(socketId).emit('new_notification', { title, message, type, time: Date.now() });
    }
}

// ==========================================
// TELEGRAM BOT UTILITY
// ==========================================
function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        .catch(err => console.error("Telegram Notification Error:", err.message));
}

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const betSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    stake: { type: Number, required: true },
    potentialWin: { type: Number, required: true },
    selections: { type: Array, required: true },
    type: { type: String, enum: ['Sports', 'Jackpot', 'Aviator', 'Casino'], default: 'Sports' },
    status: { type: String, enum: ['Open', 'Won', 'Lost', 'Cashed Out'], default: 'Open' },
    createdAt: { type: Date, default: Date.now }
});
const Bet = mongoose.model('Bet', betSchema);

const transactionSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true }, 
    userPhone: { type: String, required: true },
    type: { type: String, enum: ['deposit', 'withdraw', 'bet', 'bonus', 'win', 'cashout'], required: true },
    method: { type: String, required: true },
    amount: { type: Number, required: true }, 
    status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Success' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const liveGameSchema = new mongoose.Schema({
    id: Number, category: String, home: String, away: String,
    odds: String, draw: String, away_odds: String, time: String,
    status: { type: String, default: 'upcoming' }
}, { strict: false }); 
const LiveGame = mongoose.model('LiveGame', liveGameSchema);


// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password are required.' });

        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ phone, password: hashedPassword, name: name || 'New Player', balance: 0 });
        await newUser.save();

        sendTelegramMessage(`🚨 <b>NEW USER REGISTRATION</b> 🚨\n\n👤 <b>Name:</b> ${newUser.name}\n📱 <b>Phone:</b> ${newUser.phone}`);
        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, phone: newUser.phone } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });

        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
            if (password === user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                await user.save();
            } else {
                return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
            }
        }
        res.json({ success: true, user: { name: user.name, balance: user.balance, phone: user.phone } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==========================================
// FINANCE: DEPOSIT & WITHDRAWAL
// ==========================================
app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 50) return res.status(400).json({ success: false, message: 'Minimum deposit is 50 KES.' });

        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let formattedPhone = userPhone.replace(/\D/g, ''); 
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const APP_URL = process.env.APP_URL || 'https://apex-efwz.onrender.com';
        const reference = "DEP" + Date.now();

        const payload = {
            api_key: "MGPY26G5iWPw", 
            email: "kanyingiwaitara@gmail.com", 
            amount: amount, 
            msisdn: formattedPhone,
            callback_url: `${APP_URL}/api/megapay/webhook`,
            description: "ApexBet Deposit", 
            reference: reference
        };

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);

        await Transaction.create({ 
            refId: reference, userPhone: user.phone, type: 'deposit', method: method || 'M-Pesa', amount: Number(amount), status: 'Pending' 
        });

        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) { 
        res.status(500).json({ success: false, message: "Payment Gateway Error. Please try again." }); 
    }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
        if (responseCode != 0) return; 

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let phone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        
        if (phone.startsWith('254')) phone = '0' + phone.substring(3);

        const user = await User.findOne({ phone: phone });
        if (!user) return;

        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) return;

        user.balance += amount;
        await user.save();

        await Transaction.create({
            refId: receipt, userPhone: user.phone, type: "deposit", method: "M-Pesa", amount: amount, status: "Success"
        });

        // 🔔 REAL-TIME DEPOSIT ALERT
        sendPushNotification(user.phone, "Deposit Successful", `Your deposit of KES ${amount} has been credited.`, "deposit");
        sendTelegramMessage(`✅ <b>DEPOSIT CONFIRMED</b> ✅\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Receipt:</b> ${receipt}\n💵 <b>New Balance:</b> KES ${user.balance.toLocaleString()}`);
    } catch (err) { 
        console.error("Webhook Processing Error:", err); 
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient funds for withdrawal.' });

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method, amount: -Number(amount), status: 'Success' });

        // 🔔 REAL-TIME WITHDRAW ALERT
        sendPushNotification(user.phone, "Withdrawal Sent", `KES ${amount} has been sent to your M-Pesa.`, "withdraw");
        sendTelegramMessage(`💸 <b>WITHDRAWAL REQUEST</b> 💸\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Ref:</b> ${refId}\n💵 <b>Remaining Balance:</b> KES ${user.balance.toLocaleString()}`);

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Withdrawal processing failed' });
    }
});

app.get('/api/balance/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error fetching balance' });
    }
});

app.get('/api/transactions/:phone', async (req, res) => {
    try {
        const txns = await Transaction.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, transactions: txns });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
    }
});

// ==========================================
// BETTING ENDPOINTS
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        const user = await User.findOne({ phone: userPhone });

        if (!user || user.balance < stake) return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });

        user.balance -= stake;
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        const newBet = new Bet({ ticketId, userPhone, stake, potentialWin, selections, type: betType || 'Sports' });
        await newBet.save();

        await Transaction.create({ refId: ticketId, userPhone, type: 'bet', method: `${betType || 'Sports'} Bet`, amount: -stake });

        res.json({ success: true, newBalance: user.balance, ticketId: newBet.ticketId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Bet placement failed' });
    }
});

app.get('/api/bets/:phone', async (req, res) => {
    try {
        const bets = await Bet.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch betting history' });
    }
});

app.post('/api/cashout', async (req, res) => {
    try {
        const { ticketId, userPhone, amount } = req.body;
        
        const bet = await Bet.findOne({ ticketId: ticketId, userPhone: userPhone });
        if (!bet) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        if (bet.status !== 'Open') return res.status(400).json({ success: false, message: 'Ticket is already settled or cashed out.' });

        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        bet.status = 'Cashed Out';
        await bet.save();

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: `CO-${ticketId}`, userPhone, type: 'cashout', method: 'Cashout', amount: amount });

        // 🔔 REAL-TIME CASHOUT ALERT
        sendPushNotification(user.phone, "Bet Cashed Out", `You successfully cashed out KES ${amount}.`, "cashout");

        res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
    } catch (error) { 
        res.status(500).json({ success: false, message: 'Server error processing cashout' }); 
    }
});

// ==========================================
// BACKGROUND BET SETTLEMENT SIMULATOR
// ==========================================
setInterval(async () => {
    try {
        const openBets = await Bet.find({ status: 'Open' });
        
        for (let bet of openBets) {
            // 80% chance it stays open
            if (Math.random() > 0.20) continue; 

            // 40% chance to win, 60% chance to lose
            const isWin = Math.random() < 0.40;
            
            bet.status = isWin ? 'Won' : 'Lost';
            await bet.save();

            if (isWin) {
                const user = await User.findOne({ phone: bet.userPhone });
                if (user) {
                    user.balance += bet.potentialWin;
                    await user.save();
                    await Transaction.create({ refId: `WIN-${bet.ticketId}`, userPhone: user.phone, type: 'win', method: 'Bet Winnings', amount: bet.potentialWin });
                    
                    // 🔔 REAL-TIME WIN ALERT
                    sendPushNotification(user.phone, "Bet Won! 🥳", `Ticket ${bet.ticketId} won! KES ${bet.potentialWin} added to your balance.`, "win");
                }
            }
        }
    } catch (error) { 
        console.error("Settlement Error:", error.message); 
    }
}, 60 * 60 * 1000); // Runs every 60 minutes

// ==========================================
// ADMIN ROUTES & PUSH ALERTS
// ==========================================
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

app.put('/api/admin/users/balance', async (req, res) => {
    try {
        const { phone, newBalance } = req.body;
        if (newBalance === undefined) return res.status(400).json({ success: false, message: 'New balance is required' });

        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const oldBalance = user.balance;
        user.balance = Number(newBalance);
        await user.save();

        await Transaction.create({ refId: 'ADMIN-' + Math.floor(Math.random() * 900000), userPhone: phone, type: 'bonus', method: 'Admin Adjustment', amount: user.balance - oldBalance, status: 'Success' });

        res.json({ success: true, message: `Balance updated to KES ${user.balance}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update user balance' });
    }
});

app.delete('/api/admin/users/:phone', async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: `Account deleted.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete user account' });
    }
});

// Trigger a push alert from Admin Panel
app.post('/api/admin/push-alert', (req, res) => {
    const { phone, title, message } = req.body;
    if(phone === 'ALL') {
        io.emit('new_notification', { title, message, type: 'admin_alert', time: Date.now() });
    } else {
        sendPushNotification(phone, title, message, 'admin_alert');
    }
    res.json({success: true, message: "Alert sent!"});
});

app.post('/api/games', async (req, res) => {
    try {
        const { games, mode } = req.body;
        if (!games || !Array.isArray(games)) return res.status(400).json({ success: false, message: 'Invalid data format. Must be an array.' });

        if (mode === 'replace') await LiveGame.deleteMany({}); 
        await LiveGame.insertMany(games); 
        
        const count = await LiveGame.countDocuments();
        res.json({ success: true, message: "Games updated in database", count });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to inject games' });
    }
});

app.delete('/api/games', async (req, res) => {
    try {
        await LiveGame.deleteMany({});
        res.json({ success: true, message: "Global database cleared" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to clear database' });
    }
});

// ==========================================
// TELEGRAM LIVE CHAT BRIDGE (TWO-WAY WEB-SOCKETS)
// ==========================================
const activeChats = {};

app.get('/api/telegram/setup', async (req, res) => {
    const appUrl = process.env.APP_URL || 'https://apex-efwz.onrender.com';
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${appUrl}/api/telegram/webhook`;
    try {
        const response = await axios.get(url);
        res.json({ message: "Webhook successfully linked!", data: response.data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/support/chat-start', (req, res) => {
    const { phone, chatId } = req.body;
    sendTelegramMessage(`💬 <b>LIVE CHAT OPENED</b> 💬\n\n👤 <b>User:</b> ${phone || 'Guest'}\n🔑 <b>ID:</b> ${chatId}`);
    res.json({ success: true });
});

app.post('/api/chat/send', async (req, res) => {
    const { chatId, text, phone } = req.body;
    
    if (!activeChats[chatId]) activeChats[chatId] = [];
    activeChats[chatId].push({ sender: 'user', text });

    const tgMessage = `💬 <b>New Message</b>\n👤 <b>User:</b> ${phone || 'Guest'}\n🔑 <b>ID:</b> ${chatId}\n\n${text}`;
    
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: tgMessage, parse_mode: 'HTML' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Telegram failed' });
    }
});

app.get('/api/chat/sync', (req, res) => {
    const { chatId } = req.query;
    res.json({ success: true, messages: activeChats[chatId] || [] });
});

// Catch replies from Telegram -> Route to Website instantly via Socket
app.post('/api/telegram/webhook', (req, res) => {
    res.sendStatus(200); 
    
    try {
        const message = req.body.message;
        if (!message || !message.reply_to_message || !message.text) return;

        const originalText = message.reply_to_message.text;
        const match = originalText.match(/ID:\s*([^\n]+)/);
        
        if (match && match[1]) {
            const chatId = match[1].trim();
            if (!activeChats[chatId]) activeChats[chatId] = [];
            activeChats[chatId].push({ sender: 'admin', text: message.text });
            
            // Push via Socket instantly to the user's specific room
            io.to(chatId).emit('admin_reply', { sender: 'admin', text: message.text });
        }
    } catch(e) {
        console.error("Webhook processing error:", e);
    }
});


// ==========================================
// UNIFIED GAMES ENDPOINT (PRO MULTI-FETCH CACHING)
// ==========================================
let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 10 * 60 * 1000;

app.get('/api/games', async (req, res) => {
    try {
        // 1. ALWAYS load manually injected games from MongoDB
        const dbGamesRaw = await LiveGame.find({});
        let allGames = dbGamesRaw.map(g => g.toObject());

        // 2. Safely check for Odds API key and load automatic games if available
        if (ODDS_API_KEY && ODDS_API_KEY !== 'undefined') {
            const now = Date.now();
            
            if (now - lastApiFetchTime > API_CACHE_DURATION || cachedApiGames.length === 0) {
                try {
                    const [eplRes, ligaRes, upcomingRes] = await Promise.allSettled([
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_epl/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h,totals,btts', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_spain_la_liga/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h,totals,btts', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/upcoming/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } })
                    ]);

                    let rawApiGames = [];
                    if (eplRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...eplRes.value.data];
                    if (ligaRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...ligaRes.value.data];
                    if (upcomingRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...upcomingRes.value.data];

                    const uniqueGamesMap = new Map();
                    rawApiGames.forEach(g => { if (!uniqueGamesMap.has(g.id)) uniqueGamesMap.set(g.id, g); });
                    const uniqueGames = Array.from(uniqueGamesMap.values());

                    cachedApiGames = uniqueGames.map(m => {
                        let h = "0.00", d = null, a = "0.00";
                        let extra = { o25: "-", u25: "-", bY: "-", bN: "-", dc1x: "-", dc12: "-", dcx2: "-", dnb1: "-", dnb2: "-" };
                        
                        if (m.bookmakers && m.bookmakers.length > 0) {
                            const markets = m.bookmakers[0].markets;
                            const h2h = markets.find(mk => mk.key === 'h2h');
                            if (h2h && h2h.outcomes) {
                                const outHome = h2h.outcomes.find(o => o.name === m.home_team);
                                const outAway = h2h.outcomes.find(o => o.name === m.away_team);
                                const outDraw = h2h.outcomes.find(o => o.name.toLowerCase() === 'draw');
                                
                                if(outHome) h = outHome.price.toFixed(2);
                                if(outAway) a = outAway.price.toFixed(2);
                                if(outDraw) d = outDraw.price.toFixed(2);

                                if (h !== "0.00" && a !== "0.00") {
                                    const p1 = 1 / parseFloat(h), p2 = 1 / parseFloat(a), pX = d ? (1 / parseFloat(d)) : 0;
                                    if (d) {
                                        extra.dc1x = (1 / (p1 + pX)).toFixed(2);
                                        extra.dcx2 = (1 / (p2 + pX)).toFixed(2);
                                        extra.dc12 = (1 / (p1 + p2)).toFixed(2);
                                    }
                                    extra.dnb1 = (1 / (p1 / (p1 + p2))).toFixed(2);
                                    extra.dnb2 = (1 / (p2 / (p1 + p2))).toFixed(2);
                                }
                            }

                            const totals = markets.find(mk => mk.key === 'totals');
                            if (totals && totals.outcomes) {
                                const over = totals.outcomes.find(o => o.name.toLowerCase() === 'over');
                                const under = totals.outcomes.find(o => o.name.toLowerCase() === 'under');
                                if (over) extra.o25 = over.price.toFixed(2);
                                if (under) extra.u25 = under.price.toFixed(2);
                            }

                            const btts = markets.find(mk => mk.key === 'btts');
                            if (btts && btts.outcomes) {
                                const bY = btts.outcomes.find(o => o.name.toLowerCase() === 'yes');
                                const bN = btts.outcomes.find(o => o.name.toLowerCase() === 'no');
                                if (bY) extra.bY = bY.price.toFixed(2);
                                if (bN) extra.bN = bN.price.toFixed(2);
                            }
                        }

                        // TIME AND LIVE STATUS CALCULATION (Adapted for EAT / Kenyan Time)
                        const matchTime = new Date(m.commence_time);
                        const now = Date.now();
                        const diffMins = Math.floor((now - matchTime.getTime()) / 60000);
                        
                        let status = "upcoming", min = null, hs = 0, as = 0;
                        let timeStr = matchTime.toLocaleTimeString('en-GB', {hour: '2-digit', minute:'2-digit', timeZone: 'Africa/Nairobi'});

                        const matchDateEAT = new Date(matchTime.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
                        const nowDateEAT = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));

                        if (diffMins >= 0 && diffMins <= 110) {
                            status = "live";
                            timeStr = "Live";
                            min = diffMins > 45 && diffMins < 60 ? "HT" : diffMins > 90 ? "90+" : diffMins.toString();
                            hs = Math.floor(Math.random() * 3); 
                            as = Math.floor(Math.random() * 3);
                        } else if (matchDateEAT.getDate() === nowDateEAT.getDate() && matchDateEAT.getMonth() === nowDateEAT.getMonth()) {
                            status = "today";
                            timeStr = `Today, ${timeStr}`;
                        } else {
                            status = "upcoming";
                            timeStr = `Tomorrow, ${timeStr}`;
                        }

                        if(h === "0.00" || a === "0.00") return null;

                        return {
                            id: m.id, category: m.sport_title, league: m.sport_title, cc: 'INT',
                            home: m.home_team, away: m.away_team, odds: h, draw: d, away_odds: a,
                            time: timeStr, status: status, min: min, hs: hs, as: as, extra: extra
                        };
                    }).filter(game => game !== null);

                    lastApiFetchTime = now;
                } catch (apiErr) {
                    console.error("Odds API Integration Error:", apiErr.message);
                }
            }
            // 3. Merge DB games (injected) WITH API games
            allGames = [...allGames, ...cachedApiGames];
        }

        // 4. Return all combined games!
        res.json({ success: true, games: allGames });
    } catch (error) {
        console.error("Fetch Games Route Error:", error);
        res.status(500).json({ success: false, message: 'Failed to aggregate games' });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 ApexBet Socket Server live on port ${PORT}`);
});