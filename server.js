require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); 
const http = require('http');

const app = express();
const server = http.createServer(app); 

// ==========================================
// CORS CONFIGURATION
// ==========================================
app.use(cors({
    origin: "*", 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: false 
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const ODDS_API_KEY = process.env.ODDS_API_KEY; 

// ==========================================
// TELEGRAM BOT UTILITY (For Admin Alerts)
// ==========================================
function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("⚠️ Telegram credentials missing. Message not sent.");
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        .catch(err => console.error("Telegram Notification Error:", err.response ? err.response.data : err.message));
}

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
mongoose.connect(MONGO_URI)
  .then((conn) => console.log(`✅ Connected to MongoDB successfully! Database: ${conn.connection.name}`))
  .catch(err => console.error('❌ MongoDB connection error:', err));

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
    status: { type: String, default: 'Success' }, 
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const liveGameSchema = new mongoose.Schema({
    id: Number, category: String, home: String, away: String,
    odds: String, draw: String, away_odds: String, time: String,
    status: { type: String, default: 'upcoming' },
    commenceTime: { type: Date } // 🟢 Track exact kickoff time
}, { strict: false }); 
const LiveGame = mongoose.model('LiveGame', liveGameSchema);

const virtualResultSchema = new mongoose.Schema({
    season: Number,
    matchday: Number,
    home: String,
    away: String,
    hs: Number,
    as: Number,
    odds: Object,
    createdAt: { type: Date, default: Date.now }
});
const VirtualResult = mongoose.model('VirtualResult', virtualResultSchema);

// 🟢 Fixed Match Results Schema
const matchResultSchema = new mongoose.Schema({
    matchName: { type: String, required: true, unique: true }, // e.g., "Arsenal vs Chelsea"
    hs: { type: Number, required: true },
    as: { type: Number, required: true },
    status: { type: String, default: 'FINISHED' },
    createdAt: { type: Date, default: Date.now }
});
const MatchResult = mongoose.model('MatchResult', matchResultSchema);


// ==========================================
// 🟢 NOTIFICATIONS (EMBEDDED DB LOGIC)
// ==========================================
app.get('/api/notifications/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const unreadNotifs = user.notifications.filter(n => n.isRead === false);

        if (unreadNotifs.length > 0) {
            user.notifications.forEach(n => n.isRead = true);
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
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const notifObj = {
            id: "N-" + Date.now() + Math.floor(Math.random() * 1000),
            title: title,
            message: message,
            type: type,
            isRead: false,
            createdAt: new Date()
        };

        await User.updateMany(
            { $or: [{ phone: phone }, { phone: formattedPhone }] },
            { $push: { notifications: notifObj } }
        );
    } catch(e) { console.error("Notification Save Error", e); }
}


// ==========================================
// AUTHENTICATION & REFERRAL ENDPOINTS
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name, ref } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password are required.' });

        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });

        let referredByPhone = null;
        if (ref) {
            const cleanRef = ref.replace(/(APX-|MGO-)/i, '');
            const allUsers = await User.find({});
            const referrer = allUsers.find(u => Buffer.from(u.phone).toString('base64').substring(0, 8).toUpperCase() === cleanRef);
            if (referrer) referredByPhone = referrer.phone;
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ phone, password: hashedPassword, name: name || 'New Player', balance: 0, bonusBalance: 0, referredBy: referredByPhone });
        await newUser.save();

        sendTelegramMessage(`🚨 <b>NEW REGISTRATION</b> 🚨\n\n👤 <b>Name:</b> ${newUser.name}\n📱 <b>Phone:</b> ${newUser.phone}\n🔗 <b>Referred By:</b> ${referredByPhone || 'None'}`);
        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, bonusBalance: newUser.bonusBalance, phone: newUser.phone } });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
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
        res.json({ success: true, user: { name: user.name, balance: user.balance, bonusBalance: user.bonusBalance || 0, phone: user.phone } });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ==========================================
// CHANGE PASSWORD
// ==========================================
app.post('/api/change-password', async (req, res) => {
    try {
        const { userPhone, currentPassword, newPassword } = req.body;

        if (!userPhone || !currentPassword || !newPassword)
            return res.status(400).json({ success: false, message: 'All fields are required.' });

        if (newPassword.length < 8)
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });

        const user = await User.findOne({ phone: userPhone });
        if (!user)
            return res.status(404).json({ success: false, message: 'User not found.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password)
            || currentPassword === user.password;

        if (!isMatch)
            return res.status(401).json({ success: false, message: 'Current password is incorrect.' });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        sendTelegramMessage(`🔐 <b>PASSWORD CHANGED</b>\n\n📱 <b>Phone:</b> ${userPhone}`);

        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ==========================================
// BALANCE & TRANSACTIONS ENDPOINTS
// ==========================================
app.get('/api/balance/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone }).select('balance bonusBalance');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: user.balance, bonusBalance: user.bonusBalance || 0 });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/transactions/:phone', async (req, res) => {
    try {
        const transactions = await Transaction.find({ userPhone: req.params.phone })
            .sort({ createdAt: -1 })
            .limit(50);
        res.json({ success: true, transactions });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==========================================
// FINANCE: DEPOSIT & WITHDRAWAL
// ==========================================
app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit is 10 KES.' });

        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let formattedPhone = userPhone.replace(/\D/g, ''); 
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const APP_URL = process.env.APP_URL || 'https://betnova-1t1z.onrender.com';
        const reference = "DEP" + Date.now();

        const payload = {
            api_key: "MGPYTSDA1ZJP", 
            email: "cruisearnold3@gmail.com", 
            amount: amount, 
            msisdn: formattedPhone,
            callback_url: `${APP_URL}/api/megapay/webhook`,
            description: "Account Deposit", 
            reference: reference
        };

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        await Transaction.create({ refId: reference, userPhone: user.phone, type: 'deposit', method: method || 'M-Pesa', amount: Number(amount), status: 'Pending' });

        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) { res.status(500).json({ success: false, message: "Payment Gateway Error. Please try again." }); }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
        if (responseCode != 0) return; 

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let rawPhone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: phone0 }, { phone: phone254 }, { phone: rawPhone }] });
        if (!user) return;

        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) return;

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: receipt, userPhone: user.phone, type: "deposit", method: "M-Pesa", amount: amount, status: "Success" });

        sendPushNotification(user.phone, "Deposit Successful", `Your deposit of KES ${amount} has been credited.`, "deposit");
        sendTelegramMessage(`✅ <b>DEPOSIT CONFIRMED</b> ✅\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Receipt:</b> ${receipt}`);

        if (user.referredBy) {
            const referrer = await User.findOne({ phone: user.referredBy });
            if (referrer) {
                referrer.bonusBalance = (referrer.bonusBalance || 0) + 50;
                await referrer.save();

                await Transaction.create({ refId: `REF-BONUS-${receipt}`, userPhone: referrer.phone, type: "bonus", method: "Referral Deposit Bonus", amount: 50, status: "Success" });
                sendPushNotification(referrer.phone, "Referral Bonus! 🎁", `Your friend made a deposit! KES 50 has been added to your Bonus Wallet.`, "bonus");
            }
        }
    } catch (err) { console.error("Webhook Processing Error:", err); }
});

// 🟢 Withdraw Route (Sets to Pending Approval for Pay.html handling)
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        
        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient withdrawable funds.' });
        }

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        
        await Transaction.create({ 
            refId, 
            userPhone, 
            type: 'withdraw', 
            method: method || 'M-Pesa', 
            amount: -Number(amount), 
            status: 'Pending Approval' 
        });

        sendPushNotification(user.phone, "Withdrawal Initiated", `Your request for KES ${amount} is pending clearance.`, "withdraw");
        sendTelegramMessage(`💸 <b>WITHDRAWAL REQUEST</b> 💸\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Ref:</b> ${refId}`);

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) { 
        res.status(500).json({ success: false, message: 'Withdrawal processing failed' }); 
    }
});


// ==========================================
// SPORTS BETTING ENDPOINTS
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        
        if (!stake || stake <= 0) return res.status(400).json({ success: false, message: 'Invalid stake amount.' });

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

        await Transaction.create({ refId: ticketId, userPhone, type: 'bet', method: `${betType || 'Sports'} Bet`, amount: -stake });

        sendTelegramMessage(`🎯 <b>NEW BET PLACED</b> 🎯\n\n👤 <b>User:</b> ${userPhone}\n💸 <b>Stake:</b> KES ${stake}\n🏆 <b>Potential Win:</b> KES ${potentialWin}\n🎫 <b>Ticket:</b> ${ticketId}\n📊 <b>Type:</b> ${betType || 'Sports'}`);

        res.json({ success: true, newBalance: user.balance, newBonus: user.bonusBalance, ticketId: newBet.ticketId });
    } catch (error) { res.status(500).json({ success: false, message: 'Bet placement failed' }); }
});

app.get('/api/bets/:phone', async (req, res) => {
    try {
        const bets = await Bet.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, bets });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch betting history' }); }
});

app.post('/api/cashout', async (req, res) => {
    try {
        const { ticketId, userPhone, amount } = req.body;
        
        if (ticketId && (ticketId.startsWith('CRASH-') || ticketId.startsWith('AV-'))) {
            const user = await User.findOne({ phone: userPhone });
            if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
            
            user.balance += amount;
            await user.save();
            
            await Bet.updateOne({ ticketId: ticketId }, { $set: { status: 'Cashed Out' } });
            await Transaction.create({ refId: ticketId + '-WIN', userPhone, type: 'win', method: 'Crash Win', amount: amount });
            sendPushNotification(user.phone, "Crash Cashout! ✈️", `You successfully cashed out KES ${amount.toFixed(2)}.`, "cashout");
            
            return res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
        }

        const bet = await Bet.findOne({ ticketId: ticketId, userPhone: userPhone });
        if (!bet) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        if (bet.status !== 'Open') return res.status(400).json({ success: false, message: 'Ticket is already settled.' });

        const user = await User.findOne({ phone: userPhone });
        
        bet.status = 'Cashed Out';
        await bet.save();

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: `CO-${ticketId}`, userPhone, type: 'cashout', method: 'Cashout', amount: amount });

        sendPushNotification(user.phone, "Bet Cashed Out", `You successfully cashed out KES ${amount}.`, "cashout");
        res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error processing cashout' }); }
});


// ==========================================
// 🟢 REALISTIC SPORTS SETTLEMENT ENGINE
// ==========================================
setInterval(async () => {
    try {
        // Find all Open sports/jackpot bets
        const openBets = await Bet.find({ status: 'Open', type: { $nin: ['Aviator', 'Virtuals'] } });
        
        for (let bet of openBets) {
            let allFinished = true;
            let allWon = true;

            for (let sel of bet.selections) {
                // 1. Check if Admin injected a FIXED result for this exact match
                let fixedRes = await MatchResult.findOne({ matchName: sel.match });
                
                let hs, as, isFinished = false;

                if (fixedRes) {
                    hs = fixedRes.hs;
                    as = fixedRes.as;
                    isFinished = true;
                } else {
                    // 2. Check if the game has naturally finished based on START TIME
                    let matchStartTime = bet.createdAt; // Fallback to bet placement time
                    
                    const teams = sel.match.split(' vs ');
                    if (teams.length === 2) {
                        const game = await LiveGame.findOne({ home: teams[0].trim(), away: teams[1].trim() });
                        if (game && game.commenceTime) {
                            matchStartTime = game.commenceTime;
                        }
                    }

                    // A soccer match takes ~115 minutes from kickoff
                    const minutesSinceStart = (Date.now() - new Date(matchStartTime).getTime()) / 60000;
                    
                    if (minutesSinceStart >= 115) {
                        isFinished = true;
                        // Use $setOnInsert to prevent race conditions across multiple simultaneous tickets
                        let newRes = await MatchResult.findOneAndUpdate(
                            { matchName: sel.match },
                            { $setOnInsert: { hs: Math.floor(Math.random() * 4), as: Math.floor(Math.random() * 3), status: 'FINISHED' } },
                            { upsert: true, new: true }
                        );
                        hs = newRes.hs;
                        as = newRes.as;
                    }
                }

                if (!isFinished) {
                    allFinished = false;
                    break;
                }

                // 3. Evaluate the Pick
                let wonSelection = false;
                
                if (sel.pick === '1' && hs > as) wonSelection = true;
                else if (sel.pick === 'X' && hs === as) wonSelection = true;
                else if (sel.pick === '2' && hs < as) wonSelection = true;
                
                else if (sel.pick === 'Over 2.5' && (hs+as) > 2) wonSelection = true;
                else if (sel.pick === 'Under 2.5' && (hs+as) < 3) wonSelection = true;
                else if (sel.pick === 'Over 1.5' && (hs+as) > 1) wonSelection = true;
                else if (sel.pick === 'Under 1.5' && (hs+as) < 2) wonSelection = true;
                
                else if (sel.pick === 'GG' && hs > 0 && as > 0) wonSelection = true;
                else if (sel.pick === 'NG' && (hs === 0 || as === 0)) wonSelection = true;
                
                else if (sel.pick === '1X' && hs >= as) wonSelection = true;
                else if (sel.pick === 'X2' && hs <= as) wonSelection = true;
                else if (sel.pick === '12' && hs !== as) wonSelection = true;

                if (!wonSelection) {
                    allWon = false; // Even one wrong pick ruins an accumulator
                }
            }

            if (allFinished) {
                bet.status = allWon ? 'Won' : 'Lost';
                await bet.save();

                if (allWon) {
                    const user = await User.findOne({ phone: bet.userPhone });
                    if (user) {
                        user.balance += bet.potentialWin;
                        await user.save();
                        
                        await Transaction.create({ 
                            refId: `WIN-${bet.ticketId}`, 
                            userPhone: user.phone, 
                            type: 'win', 
                            method: 'Bet Winnings', 
                            amount: bet.potentialWin 
                        });
                        
                        sendPushNotification(user.phone, "Bet Won! 🥳", `Ticket ${bet.ticketId} won! KES ${bet.potentialWin} added to your balance.`, "win");
                    }
                } else {
                    sendPushNotification(bet.userPhone, "Bet Lost 😔", `Ticket ${bet.ticketId} didn't go your way. Better luck next time!`, "bet");
                }
            }
        }
    } catch (error) { 
        console.error("Settlement Error:", error.message); 
    }
}, 60 * 1000);


// ==========================================
// ADMIN ROUTES & PUSH ALERTS
// ==========================================
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch users' }); }
});

app.put('/api/admin/users/balance', async (req, res) => {
    try {
        const { phone, newBalance } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const oldBalance = user.balance;
        user.balance = Number(newBalance);
        await user.save();

        await Transaction.create({ refId: 'ADMIN-' + Math.floor(Math.random() * 900000), userPhone: phone, type: 'bonus', method: 'Admin Adjustment', amount: user.balance - oldBalance, status: 'Success' });
        res.json({ success: true, message: `Balance updated to KES ${user.balance}.` });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to update user balance' }); }
});

app.delete('/api/admin/users/:phone', async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: `Account deleted.` });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to delete user account' }); }
});

app.post('/api/admin/push-alert', async (req, res) => {
    try {
        const { phone, title, message } = req.body;
        
        if (phone === 'ALL') {
            const bObj = { id: "BC-" + Date.now(), title, message, type: 'admin_alert', isRead: false, createdAt: new Date() };
            await User.updateMany({}, { $push: { notifications: bObj } });
        } else {
            await sendPushNotification(phone, title, message, 'admin_alert');
        }
        res.json({success: true, message: "Alert successfully dispatched!"});
    } catch(e) { res.status(500).json({success: false, message: e.message}); }
});

// 🟢 FIXED MATCH RESULTS INJECTION
app.post('/api/admin/match-results', async (req, res) => {
    try {
        const { results } = req.body; 
        for(let r of results) {
            await MatchResult.findOneAndUpdate(
                { matchName: r.matchName },
                { hs: r.hs, as: r.as, status: 'FINISHED', createdAt: Date.now() },
                { upsert: true, new: true }
            );
        }
        res.json({ success: true, message: 'Fixed results injected successfully. Dependent bets will be settled in the next cycle.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/games', async (req, res) => {
    try {
        const { games, mode } = req.body;
        if (mode === 'replace') await LiveGame.deleteMany({}); 
        
        const formattedGames = games.map(g => ({
            ...g,
            commenceTime: g.commenceTime ? new Date(g.commenceTime) : undefined
        }));

        await LiveGame.insertMany(formattedGames); 
        res.json({ success: true, message: "Games updated in database" });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to inject games' }); }
});

app.delete('/api/games', async (req, res) => {
    try {
        await LiveGame.deleteMany({});
        res.json({ success: true, message: "Global database cleared" });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to clear database' }); }
});


// ==========================================
// 🟢 UNIFIED GAMES ENDPOINT (SPORTS API FETCHING)
// ==========================================
let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 5 * 60 * 1000;

app.get('/api/games', async (req, res) => {
    try {
        const dbGamesRaw = await LiveGame.find({});
        let allGames = dbGamesRaw.map(g => g.toObject());

        // Fetch match results for FT display
        const matchResults = await MatchResult.find({});
        const resultsMap = new Map();
        matchResults.forEach(r => resultsMap.set(r.matchName, r));

        if (ODDS_API_KEY && ODDS_API_KEY !== 'undefined') {
            const now = Date.now();
            
            if (now - lastApiFetchTime > API_CACHE_DURATION || cachedApiGames.length === 0) {
                try {
                    const [eplRes, ligaRes, upcomingRes] = await Promise.allSettled([
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_epl/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_spain_la_liga/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/upcoming/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } })
                    ]);

                    let rawApiGames = [];
                    if (eplRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...eplRes.value.data];
                    if (ligaRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...ligaRes.value.data];
                    if (upcomingRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...upcomingRes.value.data];

                    const uniqueGamesMap = new Map();
                    rawApiGames.forEach(g => { if (!uniqueGamesMap.has(g.id)) uniqueGamesMap.set(g.id, g); });
                    const uniqueGames = Array.from(uniqueGamesMap.values());

                    cachedApiGames = await Promise.all(uniqueGames.map(async m => {
                        let h = "0.00", d = null, a = "0.00";
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
                            }
                        }

                        const nH = parseFloat(h);
                        const nA = parseFloat(a);
                        if (nH < 1.05 || nA < 1.05 || nH > 50 || nA > 50) return null;
                        if (m.sport_title.toLowerCase().includes('soccer') && !d) return null;

                        const matchTime = new Date(m.commence_time);
                        const diffMins = Math.floor((now - matchTime.getTime()) / 60000);
                        const matchName = `${m.home_team} vs ${m.away_team}`;
                        
                        let status = "upcoming", min = null, hs = 0, as = 0;

                        const options = { timeZone: 'Africa/Nairobi', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
                        let timeStr = new Intl.DateTimeFormat('en-GB', options).format(matchTime).replace(/,/g, '');

                        if (diffMins > 240) return null; // Remove from feed 4 hours after kickoff

                        if (diffMins >= 115) {
                            status = "finished";
                            timeStr = "FT";
                            if (resultsMap.has(matchName)) {
                                hs = resultsMap.get(matchName).hs;
                                as = resultsMap.get(matchName).as;
                            } else {
                                // Provide a fallback score so it doesn't look blank while waiting for settlement loop
                                let newRes = await MatchResult.findOneAndUpdate(
                                    { matchName },
                                    { $setOnInsert: { hs: Math.floor(Math.random() * 4), as: Math.floor(Math.random() * 3), status: 'FINISHED' } },
                                    { upsert: true, new: true }
                                );
                                hs = newRes.hs;
                                as = newRes.as;
                                resultsMap.set(matchName, newRes);
                            }
                        } else if (diffMins >= 0 && diffMins < 115) {
                            status = "live";
                            min = diffMins > 45 && diffMins < 60 ? "HT" : diffMins > 90 ? "90+" : diffMins.toString();
                            const homeAdv = (1 / nH) > (1 / nA) ? 1.5 : 0.5;
                            hs = Math.floor((diffMins / 90) * homeAdv * 3);
                            as = Math.floor((diffMins / 90) * (2 - homeAdv) * 2);
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
            
            // Filter nulls from cached API
            cachedApiGames = cachedApiGames.filter(g => g !== null);
            allGames = [...allGames, ...cachedApiGames];
        }

        // Apply the same FT result mapping to manual DB games
        allGames = allGames.map(g => {
            const diffMins = g.commenceTime ? Math.floor((Date.now() - new Date(g.commenceTime).getTime()) / 60000) : 0;
            const matchName = `${g.home} vs ${g.away}`;
            
            if (diffMins >= 115 || g.status === 'finished') {
                g.status = 'finished';
                g.time = 'FT';
                if (resultsMap.has(matchName)) {
                    g.hs = resultsMap.get(matchName).hs;
                    g.as = resultsMap.get(matchName).as;
                }
            }
            return g;
        });

        res.json({ success: true, games: allGames });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to aggregate games' }); }
});


// ==========================================
// 🟢 SERVER-SIDE VIRTUAL LEAGUE ENGINE 🟢
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
let vStandings = V_TEAMS.map(t => ({ name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 })).sort((a,b) => a.name.localeCompare(b.name));
let vResultsHistory = [];
let currentVSeason = 1;

function generateVMatchEvents(homeProb) {
    let events = [];
    let hs = 0, as = 0;
    for(let min = 1; min <= 90; min++) {
        if(Math.random() < 0.035) { 
            if(Math.random() < homeProb) { hs++; events.push({ min, type: 'home' }); }
            else { as++; events.push({ min, type: 'away' }); }
        }
    }
    return { events, finalHs: hs, finalAs: as };
}

function createVirtualRound(matchday, startTime) {
    let shuffled = [...V_TEAMS].sort(() => 0.5 - Math.random());
    let matches = [];
    
    for(let i=0; i<10; i++) {
        const home = shuffled[i*2];
        const away = shuffled[i*2 + 1];
        
        let p1 = Math.random() * 0.4 + 0.25; 
        let p2 = Math.random() * 0.35 + 0.15; 
        let px = Math.max(0.15, 1 - (p1 + p2)); 
        
        const margin = 1.12; 
        const hBase = (1 / (p1 * margin)).toFixed(2);
        const dBase = (1 / (px * margin)).toFixed(2);
        const aBase = (1 / (p2 * margin)).toFixed(2);
        
        const sim = generateVMatchEvents(p1 / (p1 + p2));

        matches.push({
            id: `MD${matchday}-${i}`,
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
    for(let i=1; i<=38; i++) {
        vRounds.push(createVirtualRound(i, firstStart + ((i-1) * 120000))); 
    }
    
    vStandings = V_TEAMS.map(t => ({ name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 })).sort((a,b) => a.name.localeCompare(b.name));
    vResultsHistory = [];
}

startNewVirtualSeason();
let vRestartFlag = false;

setInterval(async () => {
    let now = Date.now();
    if (vRestartFlag) return;

    for (let r of vRounds) {
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

            r.matches.forEach(m => {
                let oldHs = m.hs;
                let oldAs = m.as;
                m.hs = m.events.filter(e => e.type === 'home' && e.min <= targetMinute).length;
                m.as = m.events.filter(e => e.type === 'away' && e.min <= targetMinute).length;
                m.hFlash = m.hs > oldHs;
                m.aFlash = m.as > oldAs;
            });

        } else if (timeUntilLive <= -55000 && r.status !== 'FINISHED') {
            r.status = 'FINISHED';
            r.liveMin = "FT";
            
            r.matches.forEach(m => {
                m.hs = m.events.filter(e => e.type === 'home').length;
                m.as = m.events.filter(e => e.type === 'away').length;
            });

            // 1. UPDATE STANDINGS & RESULTS
            r.matches.forEach(m => {
                vResultsHistory.unshift({ md: r.matchday, match: `${m.home.short} - ${m.away.short}`, score: `${m.hs} : ${m.as}` });
                
                let hTeam = vStandings.find(t => t.name === m.home.name);
                let aTeam = vStandings.find(t => t.name === m.away.name);
                hTeam.p++; aTeam.p++;
                hTeam.gd += (m.hs - m.as); aTeam.gd += (m.as - m.hs);
                if(m.hs > m.as) hTeam.pts += 3;
                else if (m.hs < m.as) aTeam.pts += 3;
                else { hTeam.pts += 1; aTeam.pts += 1; }
            });

            // 2. SETTLE BETS IN DB
            try {
                const pendingVBets = await Bet.find({ type: 'Virtuals', status: 'Open', 'selections.0.roundId': r.id });
                
                for (let b of pendingVBets) {
                    const matchId = b.selections[0].matchId;
                    const m = r.matches.find(mx => mx.id === matchId);
                    
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
                            await Transaction.create({ refId: `VWIN-${b.ticketId}`, userPhone: b.userPhone, type: 'win', method: 'Virtual Win', amount: b.potentialWin });
                            sendPushNotification(b.userPhone, "Virtual Bet Won! 🎉", `Your virtual bet won KES ${b.potentialWin}!`, "win");
                        }
                    }
                }
            } catch(e) { console.error("Virtual Settlement Error:", e); }

            // 3. PERSIST MATCHES TO DB 
            try {
                const resultsToSave = r.matches.map(m => ({
                    season: currentVSeason,
                    matchday: r.matchday,
                    home: m.home.name,
                    away: m.away.name,
                    hs: m.hs,
                    as: m.as,
                    odds: m.odds
                }));
                await VirtualResult.insertMany(resultsToSave);
            } catch(e) {}

            // 4. CHECK END OF SEASON
            if (r.matchday === 38) {
                vRestartFlag = true;
                setTimeout(() => {
                    currentVSeason++;
                    startNewVirtualSeason();
                    vRestartFlag = false;
                }, 5000);
            }
        }
    }
}, 1000);

app.get('/api/virtuals/state', (req, res) => {
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
// 🟢 CRASH GAME ENGINE & REFUND LOGIC
// ==========================================
let aviatorState = {
    status: 'WAITING',
    startTime: 0,
    crashPoint: 1.00,
    history: [1.24, 3.87, 11.20, 1.01, 6.42]
};

function runAviatorLoop() {
    if (aviatorState.status === 'WAITING') {
        setTimeout(() => {
            aviatorState.status = 'FLYING';
            aviatorState.startTime = Date.now();
            
            aviatorState.crashPoint = Math.random() < 0.4 ? (1.00 + Math.random() * 0.5) : (1.5 + Math.random() * 10);
            const flightDuration = (Math.log(aviatorState.crashPoint) / 0.06) * 1000;
            
            setTimeout(() => {
                aviatorState.status = 'CRASHED';
                aviatorState.history.unshift(aviatorState.crashPoint);
                if(aviatorState.history.length > 20) aviatorState.history.pop();
                
                // Set all open Aviator bets to 'Lost' automatically upon crash
                Bet.updateMany({ type: 'Aviator', status: 'Open' }, { $set: { status: 'Lost' } }).catch(e=>{});
                
                setTimeout(() => {
                    aviatorState.status = 'WAITING';
                    runAviatorLoop(); 
                }, 4000);
                
            }, flightDuration);

        }, 5000);
    }
}
runAviatorLoop();

app.get('/api/aviator/state', (req, res) => {
    res.json({
        success: true,
        status: aviatorState.status,
        startTime: aviatorState.startTime,
        crashPoint: aviatorState.status === 'CRASHED' ? aviatorState.crashPoint : null,
        history: aviatorState.history
    });
});

app.post('/api/aviator/bet', async (req, res) => {
    try {
        const { userPhone, amount } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false });

        const betAmt = Number(amount);

        // 🟢 Refund Logic
        if (betAmt < 0) {
            user.balance += Math.abs(betAmt);
            await user.save();
            await Transaction.create({ refId: `CRASH-REF-${Date.now()}`, userPhone, type: 'refund', method: 'Crash Refund', amount: Math.abs(betAmt) });
            await Bet.findOneAndDelete({ userPhone: userPhone, type: 'Aviator', status: 'Open' });
            return res.json({ success: true, newBalance: user.balance });
        }

        // 🟢 Standard Bet Placement
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
            
            const tId = `CRASH-BET-${Date.now()}`;
            await Transaction.create({ refId: tId, userPhone, type: 'bet', method: 'Crash Bet', amount: -betAmt });
            
            await Bet.create({
                ticketId: tId,
                userPhone: user.phone,
                stake: betAmt,
                potentialWin: 0,
                type: 'Aviator',
                status: 'Open',
                selections: [{ match: "Crash Round", market: "Crash", pick: "Auto", odds: 1.0 }]
            });

            sendTelegramMessage(`✈️ <b>NEW AVIATOR BET</b> ✈️\n\n👤 <b>User:</b> ${userPhone}\n💸 <b>Stake:</b> KES ${betAmt}\n🎫 <b>Ticket:</b> ${tId}`);
            res.json({ success: true, newBalance: user.balance });
        } else {
            res.status(400).json({ success: false, message: "Insufficient Funds" });
        }
    } catch(e) { res.status(500).json({ success: false }); }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 MegaOdds Server live on port ${PORT}`);
});