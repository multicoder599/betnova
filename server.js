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
        parse_mode: 'HTML' // Allows bold <b> and italic <i> tags
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
    /https:\/\/.*\.surge\.sh$/ // Securely allows any surge.sh subdomain
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

// --- 1. User Model ---
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- 2. Bet Model ---
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

// --- 3. Transaction Model ---
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

// --- 4. Live Game Model ---
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
// SECURE ODDS API PROXY
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
        
        if (!phone || !password) {
            return res.status(400).json({ success: false, message: 'Phone and password are required.' });
        }

        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ 
            phone, 
            password: hashedPassword, 
            name: name || 'New Player', 
            balance: 100 
        });
        await newUser.save();

        await Transaction.create({
            refId: 'BONUS-' + Math.floor(Math.random() * 900000),
            userPhone: phone,
            type: 'bonus',
            method: 'Welcome Bonus',
            amount: 100
        });

        // 🚨 TELEGRAM NOTIFICATION: NEW USER
        sendTelegramMessage(
            `🚨 <b>NEW USER REGISTRATION</b> 🚨\n\n` +
            `👤 <b>Name:</b> ${newUser.name}\n` +
            `📱 <b>Phone:</b> ${newUser.phone}\n` +
            `🎁 <b>Welcome Bonus:</b> KES 100`
        );

        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, phone: newUser.phone } });
    } catch (error) {
        console.error("Registration Error: ", error);
        res.status(500).json({ success: false, message: 'Server crash details: ' + error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
        }

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
        console.error("Login Error: ", error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// ==========================================
// FINANCE: MEGAPAY STK PUSH (DEPOSIT)
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

        const response = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);

        await Transaction.create({ 
            refId: reference, 
            userPhone: user.phone, 
            type: 'deposit', 
            method: method || 'M-Pesa', 
            amount: Number(amount),
            status: 'Pending' 
        });

        res.status(200).json({ 
            success: true, 
            message: "STK Push Sent! Check your phone.",
            newBalance: user.balance, 
            refId: reference 
        });

    } catch (error) { 
        console.error("STK Error:", error);
        res.status(500).json({ success: false, message: "Payment Gateway Error. Please try again." }); 
    }
});

// ==========================================
// FINANCE: MEGAPAY WEBHOOK (RECEIVES CONFIRMATION)
// ==========================================
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
        if (!user) {
            console.log(`Webhook Error: Unregistered phone paid ${amount} - ${phone}`);
            return;
        }

        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) {
            console.log(`Duplicate Webhook ignored for receipt: ${receipt}`);
            return;
        }

        user.balance += amount;
        await user.save();

        await Transaction.create({
            refId: receipt, 
            userPhone: user.phone,
            type: "deposit",
            method: "M-Pesa",
            amount: amount,
            status: "Success"
        });

        // 🚨 TELEGRAM NOTIFICATION: SUCCESSFUL DEPOSIT
        sendTelegramMessage(
            `✅ <b>DEPOSIT CONFIRMED</b> ✅\n\n` +
            `👤 <b>User:</b> ${user.phone}\n` +
            `💰 <b>Amount:</b> KES ${amount}\n` +
            `🧾 <b>Receipt:</b> ${receipt}\n` +
            `💵 <b>New Balance:</b> KES ${user.balance.toLocaleString()}`
        );
        
    } catch (err) { 
        console.error("Webhook Processing Error:", err); 
    }
});

// ==========================================
// FINANCE: WITHDRAWAL REQUEST
// ==========================================
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient funds for withdrawal.' });
        }

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method, amount: -Number(amount), status: 'Success' });

        // 🚨 TELEGRAM NOTIFICATION: WITHDRAWAL REQUEST
        sendTelegramMessage(
            `💸 <b>WITHDRAWAL REQUEST</b> 💸\n\n` +
            `👤 <b>User:</b> ${user.phone}\n` +
            `💰 <b>Amount:</b> KES ${amount}\n` +
            `🧾 <b>Ref:</b> ${refId}\n` +
            `💵 <b>Remaining Balance:</b> KES ${user.balance.toLocaleString()}`
        );

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Withdrawal processing failed' });
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
// BETTING ENDPOINT
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        const user = await User.findOne({ phone: userPhone });

        if (!user || user.balance < stake) {
            return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });
        }

        user.balance -= stake;
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        
        const newBet = new Bet({ 
            ticketId, userPhone, stake, potentialWin, selections, type: betType || 'Sports' 
        });
        await newBet.save();

        await Transaction.create({
            refId: ticketId,
            userPhone,
            type: 'bet',
            method: `${betType || 'Sports'} Bet`,
            amount: -stake
        });

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
        console.error("Fetch Bets Error:", error);
        res.status(500).json({ success: false, message: 'Failed to fetch betting history' });
    }
});


// ==========================================
// ADMIN LIVE GAMES INJECTOR ENDPOINTS
// ==========================================
app.get('/api/games', async (req, res) => {
    try {
        const games = await LiveGame.find({});
        res.json({ success: true, games });
    } catch (error) {
        console.error("Fetch Games Error:", error);
        res.status(500).json({ success: false, message: 'Failed to fetch games' });
    }
});

app.post('/api/games', async (req, res) => {
    try {
        const { games, mode } = req.body;
        
        if (!games || !Array.isArray(games)) {
            return res.status(400).json({ success: false, message: 'Invalid data format. Must be an array.' });
        }

        if (mode === 'replace') {
            await LiveGame.deleteMany({}); // Wipe DB clean
        }
        
        await LiveGame.insertMany(games); // Save new games to MongoDB
        
        const totalCount = await LiveGame.countDocuments();
        res.json({ success: true, message: "Games updated in database", count: totalCount });
    } catch (error) {
        console.error("Inject Games Error:", error);
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