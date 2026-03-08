require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); 

const app = express();

// ==========================================
// TELEGRAM BOT UTILITY
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Fire-and-forget background function
function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("Telegram alert missed (Credentials missing in .env):", message);
        return;
    }
    
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML' 
    }).catch(err => {
        console.error("Telegram Notification Error:", err.message);
    });
}

// ==========================================
// CORS CONFIGURATION
// ==========================================
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    /https:\/\/.*\.surge\.sh$/ 
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.some(domain => 
            typeof domain === 'string' ? domain === origin : domain.test(origin)
        )) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

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
    type: { type: String, enum: ['deposit', 'withdraw', 'bet', 'bonus', 'win'], required: true },
    method: { type: String, required: true },
    amount: { type: Number, required: true }, 
    status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Success' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const liveGameSchema = new mongoose.Schema({
    id: Number,
    category: String,
    home: String,
    away: String,
    odds: String,
    draw: String,
    away_odds: String,
    time: String,
    status: { type: String, default: 'upcoming' }
}, { strict: false }); 
const LiveGame = mongoose.model('LiveGame', liveGameSchema);


// ==========================================
// SECURE ODDS API PROXY (PAID TIER)
// ==========================================
const ODDS_API_KEY = process.env.ODDS_API_KEY;

app.get('/api/sports', async (req, res) => {
    try {
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
        res.json(response.data);
    } catch (error) {
        console.error('Odds API Sports Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch sports' });
    }
});

app.get('/api/odds/:sportKey', async (req, res) => {
    try {
        const { sportKey } = req.params;
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
            params: {
                apiKey: ODDS_API_KEY,
                regions: 'eu,uk,us', 
                markets: 'h2h,totals,btts', 
                oddsFormat: 'decimal'
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Odds API Matches Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch odds' });
    }
});

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
        res.status(500).json({ success: false, message: 'Server crash details: ' + error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });

        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
            // Legacy plaintext login fallback
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

// ==========================================
// ADMIN ROUTES
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


// ==========================================
// UNIFIED GAMES ENDPOINT (API CACHING + DB MERGE)
// ==========================================

let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 5 * 60 * 1000; // Cache API results for 5 minutes

app.get('/api/games', async (req, res) => {
    try {
        // 1. Fetch Manual Games injected by Admin
        const dbGamesRaw = await LiveGame.find({});
        let allGames = dbGamesRaw.map(g => g.toObject());

        // 2. Fetch Live Games from The Odds API (Only once every 5 mins)
        if (ODDS_API_KEY) {
            const now = Date.now();
            
            if (now - lastApiFetchTime > API_CACHE_DURATION || cachedApiGames.length === 0) {
                try {
                    const apiRes = await axios.get(`https://api.the-odds-api.com/v4/sports/upcoming/odds/`, {
                        params: {
                            apiKey: ODDS_API_KEY,
                            regions: 'eu,uk,us',
                            markets: 'h2h,totals,btts',
                            oddsFormat: 'decimal'
                        }
                    });

                    // 3. Deep Market Parser & Math Calculator
                    cachedApiGames = apiRes.data.map(m => {
                        let h = "0.00", d = null, a = "0.00";
                        let extra = { o25: "-", u25: "-", bY: "-", bN: "-", dc1x: "-", dc12: "-", dcx2: "-", dnb1: "-", dnb2: "-" };
                        
                        if (m.bookmakers && m.bookmakers.length > 0 && m.bookmakers[0].markets) {
                            const markets = m.bookmakers[0].markets;
                            
                            // Extract Main 1X2
                            const h2h = markets.find(mk => mk.key === 'h2h');
                            if (h2h && h2h.outcomes) {
                                const outHome = h2h.outcomes.find(o => o.name === m.home_team);
                                const outAway = h2h.outcomes.find(o => o.name === m.away_team);
                                const outDraw = h2h.outcomes.find(o => o.name.toLowerCase() === 'draw');
                                
                                if(outHome) h = outHome.price.toFixed(2);
                                if(outAway) a = outAway.price.toFixed(2);
                                if(outDraw) d = outDraw.price.toFixed(2);

                                // Calculate Double Chance and DNB mathematically based on H2H
                                if (h !== "0.00" && a !== "0.00") {
                                    const p1 = 1 / parseFloat(h);
                                    const p2 = 1 / parseFloat(a);
                                    const pX = d ? (1 / parseFloat(d)) : 0;
                                    
                                    if (d) {
                                        extra.dc1x = (1 / (p1 + pX)).toFixed(2);
                                        extra.dcx2 = (1 / (p2 + pX)).toFixed(2);
                                        extra.dc12 = (1 / (p1 + p2)).toFixed(2);
                                    }
                                    extra.dnb1 = (1 / (p1 / (p1 + p2))).toFixed(2);
                                    extra.dnb2 = (1 / (p2 / (p1 + p2))).toFixed(2);
                                }
                            }

                            // Extract Totals (Over/Under)
                            const totals = markets.find(mk => mk.key === 'totals');
                            if (totals && totals.outcomes) {
                                const over = totals.outcomes.find(o => o.name.toLowerCase() === 'over');
                                const under = totals.outcomes.find(o => o.name.toLowerCase() === 'under');
                                if (over) extra.o25 = over.price.toFixed(2);
                                if (under) extra.u25 = under.price.toFixed(2);
                            }

                            // Extract BTTS
                            const btts = markets.find(mk => mk.key === 'btts');
                            if (btts && btts.outcomes) {
                                const bY = btts.outcomes.find(o => o.name.toLowerCase() === 'yes');
                                const bN = btts.outcomes.find(o => o.name.toLowerCase() === 'no');
                                if (bY) extra.bY = bY.price.toFixed(2);
                                if (bN) extra.bN = bN.price.toFixed(2);
                            }
                        }

                        // Smart Live Math Formatting
                        const matchTime = new Date(m.commence_time);
                        const nowTime = new Date();
                        const diffMins = Math.floor((nowTime - matchTime) / 60000);
                        
                        let status = "upcoming";
                        let min = null, hs = null, as = null;
                        let timeStr = matchTime.toLocaleTimeString('en-GB', {hour: '2-digit', minute:'2-digit'});

                        if (diffMins >= 0 && diffMins <= 110) {
                            status = "live";
                            timeStr = "Live";
                            min = diffMins > 45 && diffMins < 60 ? "HT" : diffMins > 90 ? "90+" : diffMins.toString();
                            hs = Math.floor(Math.random() * 3); 
                            as = Math.floor(Math.random() * 3);
                        } else if (matchTime.getDate() === nowTime.getDate()) {
                            timeStr = `Today, ${timeStr}`;
                        } else {
                            timeStr = `Tomorrow, ${timeStr}`;
                        }

                        if(h === "0.00" || a === "0.00") return null;

                        return {
                            id: m.id, category: m.sport_title, league: m.sport_title, cc: 'INT',
                            home: m.home_team, away: m.away_team, odds: h, draw: d, away_odds: a,
                            time: timeStr, status: status, min: min, hs: hs, as: as,
                            extra: extra // Inject parsed real extra markets here
                        };
                    }).filter(game => game !== null);

                    lastApiFetchTime = now;
                } catch (apiErr) {
                    console.error("Odds API Integration Error (Using Cache):", apiErr.message);
                }
            }
            allGames = [...allGames, ...cachedApiGames];
        }

        res.json({ success: true, games: allGames });
    } catch (error) {
        console.error("Fetch Games Route Error:", error);
        res.status(500).json({ success: false, message: 'Failed to aggregate games' });
    }
});

app.post('/api/games', async (req, res) => {
    try {
        const { games, mode } = req.body;
        if (!games || !Array.isArray(games)) return res.status(400).json({ success: false, message: 'Invalid data format.' });

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
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 ApexBet Server live on port ${PORT}`);
});