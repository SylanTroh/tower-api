const express = require('express');
const rateLimit = require('express-rate-limit');
const md5 = require("md5");
const readline = require('readline');
const { Pool } = require('pg');
const env = require('dotenv').config();

const app = express();

// Trust proxy to get real IP addresses
app.set('trust proxy', true);

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT,
    password: process.env.PGPASSWORD,
});

// Environment variables
const otpkey = process.env.OTP_KEY;
const interval = 10;

// IP blocking configuration
// Temporarily blocks ips that submit too many failed OTPs
const IP_BLOCK_CONFIG = {
    maxFailedAttempts: 3,
    timeWindowMinutes: 3,
    blockDurationMinutes: 1,
    cleanupIntervalMinutes: 30
};

if (!otpkey) {
    console.error('OTP_KEY environment variable is required');
    process.exit(1);
}

// In-memory storage for failed attempts and blocked IPs
const ipFailures = new Map(); // ip -> { count, firstAttempt, lastAttempt }
const blockedIPs = new Map(); // ip -> { blockedAt, unblockAt }

// Write queue to handle race conditions
class WriteQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    async enqueue(operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const { operation, resolve, reject } = this.queue.shift();

            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }

        this.isProcessing = false;
    }
}

const writeQueue = new WriteQueue();

// Cache objects with TTL
const cache = {
    bricks: { value: null, expires: 0 },
    otp: { value: null, counter: null, expires: 0 }
};

//Due to the limitations of VRChat, I cannot truly make this API secure. So we ask nicely
const asknicely = "<p>Hi! This is Sylan!<br>" +
    "If you're here, that means you're poking around at the server for my tower world.<br>" +
    "It's pretty cool that you've managed to get here, I myself love to tinker around with things and figure out how they work, but I would like to please ask you to consider the following before poking any further:<br>" +
    "I made this world because I wanted to make a fun experience that brings people together.<br>" +
    "To accomplish this, I pay for the server that makes this possible out of pocket, and I am more than willing to do so because it makes me happy to see others having fun.<br>" +
    "I don't make any money from this world. This means that if bots or users outside VR decide to flood the server with requests, I will likely not be able to afford to keep it running anymore, shutting it down for everyone.<br>" +
    "While I can't possibly know your intentions, I hope you can keep that in mind if you decide to continue poking around here.<br>" +
    "<br>" +
    "- Sylan</p>"

// IP blocking functions
function getClientIP(req) {
    return req.ip || req.connection.remoteAddress || 'unknown';
}

function isIPBlocked(ip) {
    const blocked = blockedIPs.get(ip);
    if (!blocked) return false;

    const now = Date.now();
    if (now >= blocked.unblockAt) {
        // Block has expired, remove it
        blockedIPs.delete(ip);
        return false;
    }

    return true;
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    const timeWindowMs = IP_BLOCK_CONFIG.timeWindowMinutes * 60 * 1000;
    const existing = ipFailures.get(ip);

    if (existing) {
        // Filter out attempts older than the time window
        existing.attempts = existing.attempts.filter(attemptTime => now - attemptTime < timeWindowMs);
        // Add the current attempt
        existing.attempts.push(now);
        existing.lastAttempt = now;
    } else {
        ipFailures.set(ip, {
            attempts: [now],
            firstAttempt: now,
            lastAttempt: now
        });
    }

    const failure = ipFailures.get(ip);

    // Check if we should block this IP
    if (failure.attempts.length >= IP_BLOCK_CONFIG.maxFailedAttempts) {
        const blockDurationMs = IP_BLOCK_CONFIG.blockDurationMinutes * 60 * 1000;
        blockedIPs.set(ip, {
            blockedAt: now,
            unblockAt: now + blockDurationMs
        });

        console.log(`IP ${ip} blocked for ${IP_BLOCK_CONFIG.blockDurationMinutes} minutes after ${failure.attempts.length} failed attempts within ${IP_BLOCK_CONFIG.timeWindowMinutes} minutes`);
    }
}

function recordSuccessfulAttempt(ip) {
    // Clear any failed attempts for this IP on successful OTP
    ipFailures.delete(ip);
}

// Cleanup expired failures periodically
function cleanupExpiredFailures() {
    const now = Date.now();
    const timeWindowMs = IP_BLOCK_CONFIG.timeWindowMinutes * 60 * 1000;

    for (const [ip, failure] of ipFailures.entries()) {
        // Filter out old attempts
        failure.attempts = failure.attempts.filter(attemptTime => now - attemptTime < timeWindowMs);

        // Remove the entry if no attempts remain in the window
        if (failure.attempts.length === 0) {
            ipFailures.delete(ip);
        }
    }

    // Also cleanup expired blocks
    for (const [ip, block] of blockedIPs.entries()) {
        if (now >= block.unblockAt) {
            blockedIPs.delete(ip);
        }
    }
}

// Check if IP is blocked
function checkIPBlocked(req, res, next) {
    const ip = getClientIP(req);

    if (isIPBlocked(ip)) {
        const blocked = blockedIPs.get(ip);
        const remainingTime = Math.ceil((blocked.unblockAt - Date.now()) / (60 * 1000));

        console.log(`Blocked IP ${ip} attempted access. ${remainingTime} minutes remaining.`);

        res.status(400).send(asknicely);
        return;
    }

    next();
}

async function logIPAttempt(ip, otp, success, endpoint) {
    try {
        await writeQueue.enqueue(async () => {
            const client = await pool.connect();
            try {
                await client.query(`
                    INSERT INTO ip_logs (ip_address, otp_attempted, success, endpoint, attempted_at)
                    VALUES ($1, $2, $3, $4, NOW())
                `, [ip, otp, success, endpoint]);
            } finally {
                client.release();
            }
        });
    } catch (error) {
        console.error('Error logging IP attempt:', error);
    }
}

function MD5Hash(str) {
    const hash = md5(str);
    return hash;
}

function CalculateCounter() {
    const d = new Date();
    let timeInSeconds = Math.floor(d.getTime() / 1000);
    return Math.floor(timeInSeconds / interval);
}

function CalculateOTP(counter) {
    //This is not meant to be secure. I just need a stable hash
    const now = Date.now();

    // Check if we have a cached OTP for this counter
    if (cache.otp.counter === counter && cache.otp.expires > now) {
        return cache.otp.value;
    }

    let hashCode = MD5Hash(otpkey + counter);
    let firstFour = hashCode.slice(0, 4);
    let otp = Number("0x" + firstFour);
    otp = (otp & 1023) + 1;

    // Cache the OTP result for the remainder of the current interval
    const nextIntervalStart = Math.ceil(Date.now() / 1000 / interval) * interval * 1000;
    cache.otp = {
        value: otp,
        counter: counter,
        expires: nextIntervalStart
    };

    return otp;
}

function CleanupCache() {
    //Remove expired entries in the cache. Only OTPs for now
    const now = Date.now();
    for (const [counter, otpData] of cache.otps.entries()) {
        if (otpData.expires <= now) {
            cache.otps.delete(counter);
        }
    }
}

function CheckOTP(otp){
    let counter = CalculateCounter()
    let currentOTP = CalculateOTP(counter);
    let prevOTP = CalculateOTP(counter-1);
    return (otp == currentOTP) || (otp == prevOTP)
}

function SuccessResponseBricks(bricks, res, req) {
    res.status(200).send(bricks.toString());
}

function SuccessResponseTime(res, req) {
    const d = new Date();
    let time = d.getTime();
    res.status(200).send(time.toString());
}

function FailureResponse(res, req, logAttempt = true) {
    const ip = getClientIP(req);

    if (logAttempt) {
        recordFailedAttempt(ip);
        logIPAttempt(ip, req.params.id, false, req.path);
    }

    console.log(`Error: Incorrect otp: ${req.params.id} from IP: ${ip}`);
    res.status(400).send(asknicely);
}

async function getBricks() {
    const now = Date.now();

    // Check cache first
    if (cache.bricks.expires > now && cache.bricks.value !== null) {
        return cache.bricks.value;
    }

    try {
        const client = await pool.connect();
        try {
            const result = await client.query('SELECT count FROM bricks WHERE id = 1');
            const bricks = result.rows[0]?.count || 0;

            // Cache the result for 60 seconds
            cache.bricks = {
                value: bricks,
                expires: now + 60000
            };

            return bricks;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error getting bricks:', error);
        return cache.bricks.value || 0; // Return cached value if available
    }
}

async function incrementBricks(num) {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(`
                INSERT INTO bricks (id, count) VALUES (1, $1)
                    ON CONFLICT (id) DO UPDATE SET count = bricks.count + $1, updated_at = NOW()
                                            RETURNING count
            `, [num]);

            const newCount = result.rows[0].count;

            // Update cache immediately with new count
            cache.bricks = {
                value: newCount,
                expires: Date.now() + 60000
            };

            return newCount;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error incrementing bricks:', error);
        throw error;
    }
}

async function setBricks(num) {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(`
                INSERT INTO bricks (id, count) VALUES (1, $1)
                    ON CONFLICT (id) DO UPDATE SET count = $1, updated_at = NOW()
                                            RETURNING count
            `, [num]);

            const newCount = result.rows[0].count;

            // Update cache immediately with new count
            cache.bricks = {
                value: newCount,
                expires: Date.now() + 60000
            };

            return newCount;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error setting bricks:', error);
        throw error;
    }
}

async function logBricks() {
    try {
        const client = await pool.connect();
        try {
            const bricks = await getBricks();
            await client.query(`
                INSERT INTO brick_logs (logged_at, count) VALUES (NOW(), $1)
            `, [bricks]);

            console.log(`Logged ${bricks} bricks`);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error logging bricks:', error);
    }
}

//Show Current Bricks
app.get('/', async (req, res) => {
    try {
        const currentBricks = await getBricks();
        SuccessResponseBricks(currentBricks, res, req);
    } catch (error) {
        console.error('Error getting bricks:', error);
        FailureResponse(res, req, false); // Don't log this as a failed OTP attempt
    }
});

//Show Server Time
app.get('/time', (req, res) => {
    SuccessResponseTime(res,req);
});

//Add One Brick
app.get('/place/:id', checkIPBlocked, async (req, res) => {
    const ip = getClientIP(req);

    if(CheckOTP(req.params.id)) {
        recordSuccessfulAttempt(ip);
        await logIPAttempt(ip, req.params.id, true, req.path);
        await PlaceBrick(1, res, req);
    } else {
        FailureResponse(res, req);
    }
});

//Add Two Bricks
app.get('/place2/:id', checkIPBlocked, async (req, res) => {
    const ip = getClientIP(req);

    if(CheckOTP(req.params.id)) {
        recordSuccessfulAttempt(ip);
        await logIPAttempt(ip, req.params.id, true, req.path);
        await PlaceBrick(2, res, req);
    } else {
        FailureResponse(res, req);
    }
});

//Add Three Bricks
app.get('/place3/:id', checkIPBlocked, async (req, res) => {
    const ip = getClientIP(req);

    if(CheckOTP(req.params.id)) {
        recordSuccessfulAttempt(ip);
        await logIPAttempt(ip, req.params.id, true, req.path);
        await PlaceBrick(3, res, req);
    } else {
        FailureResponse(res, req);
    }
});

function startServer() {
    const port = process.env.PORT || 3000;

    app.listen(port, () => {
        console.log(`App is running behind Nginx on port ${port}`);
    });
}

async function PlaceBrick(num, res, req) {
    try {
        await writeQueue.enqueue(async () => {
            return await incrementBricks(num);
        });

        const currentBricks = await getBricks();
        console.log(`Placed ${num} brick(s). Total: ${currentBricks} on ID: ${req.params.id}`);
        SuccessResponseBricks(currentBricks, res, req);
    } catch (error) {
        console.error('Error placing brick:', error);
        FailureResponse(res, req, false); // Don't log this as failed OTP attempt
    }
}

async function SaveBricks() {
    try {
        await writeQueue.enqueue(async () => {
            return await logBricks();
        });
    } catch (error) {
        console.error('Error saving bricks:', error);
    }
}

/// Console Prompt

const commands = {
    setbricks: async (number) => {
        const newBricks = parseInt(number);
        if (isNaN(newBricks)) {
            console.log('Invalid number provided');
            return;
        }

        try {
            await writeQueue.enqueue(async () => {
                return await setBricks(newBricks);
            });

            console.log(`Set bricks to ${newBricks}`);
        } catch (error) {
            console.error('Error setting bricks:', error);
        }
    },

    getbricks: async () => {
        try {
            const currentBricks = await getBricks();
            console.log(`Current bricks: ${currentBricks}`);
        } catch (error) {
            console.error('Error getting bricks:', error);
        }
    },

    time: () => {
        console.log(`Current time: ${new Date().toLocaleString()}`);
    },

    showblocked: () => {
        console.log('\nCurrently blocked IPs:');
        if (blockedIPs.size === 0) {
            console.log('  No IPs currently blocked');
        } else {
            for (const [ip, block] of blockedIPs.entries()) {
                const remainingTime = Math.ceil((block.unblockAt - Date.now()) / (60 * 1000));
                console.log(`  ${ip} - ${remainingTime} minutes remaining`);
            }
        }
    },

    showfailures: () => {
        console.log('\nIPs with failed attempts:');
        if (ipFailures.size === 0) {
            console.log('  No failed attempts recorded');
        } else {
            const now = Date.now();
            for (const [ip, failure] of ipFailures.entries()) {
                const recentAttempts = failure.attempts.length;
                const lastAttemptTime = new Date(failure.lastAttempt).toLocaleString();
                const timeUntilReset = Math.ceil((failure.attempts[0] + (IP_BLOCK_CONFIG.timeWindowMinutes * 60 * 1000) - now) / (60 * 1000));
                console.log(`  ${ip} - ${recentAttempts}/${IP_BLOCK_CONFIG.maxFailedAttempts} attempts (last: ${lastAttemptTime}, resets in: ${timeUntilReset}min)`);
            }
        }
    },

    unblockip: (ip) => {
        if (!ip) {
            console.log('Please provide an IP address to unblock');
            return;
        }

        if (blockedIPs.delete(ip)) {
            console.log(`Unblocked IP: ${ip}`);
        } else {
            console.log(`IP ${ip} was not blocked`);
        }
    },

    clearfailures: (ip) => {
        if (ip) {
            if (ipFailures.delete(ip)) {
                console.log(`Cleared failures for IP: ${ip}`);
            } else {
                console.log(`No failures recorded for IP: ${ip}`);
            }
        } else {
            ipFailures.clear();
            console.log('Cleared all failure records');
        }
    },

    help: () => {
        console.log('\nAvailable commands:');
        Object.keys(commands).forEach(cmd => {
            console.log(`  ${cmd}`);
        });
    },

    exit: () => {
        console.log('Goodbye!');
        process.exit(0);
    }
};

// Create an interface for input and output
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Function to parse and execute commands
function executeCommand(input) {
    const args = input.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const params = args.slice(1);

    if (commands[command]) {
        try {
            commands[command](...params);
        } catch (error) {
            console.error(`Error executing command '${command}':`, error.message);
        }
    } else if (command === '') {
        // Do nothing for empty input
        return;
    } else {
        console.log(`Unknown command: '${command}'. Type 'help' for available commands.`);
    }
}

// Main CLI loop
function startCLI() {
    console.log('Simple CLI started. Type "help" for commands or "exit" to quit.\n');

    const prompt = () => {
        rl.question('> ', (input) => {
            executeCommand(input);
            prompt(); // Continue the loop
        });
    };

    // Override console methods to reprint prompt after logging
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    console.log = (...args) => {
        // Clear current line and move cursor to beginning
        process.stdout.write('\r\x1b[K');
        originalConsoleLog.apply(console, args);
        // Reprint the prompt
        process.stdout.write('> ');
    };

    console.error = (...args) => {
        // Clear current line and move cursor to beginning
        process.stdout.write('\r\x1b[K');
        originalConsoleError.apply(console, args);
        // Reprint the prompt
        process.stdout.write('> ');
    };

    prompt();
}

// Handle Ctrl+C gracefully
rl.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Goodbye!');
    process.exit(0);
});

// Initialize database connection and create tables if needed
async function initializeDatabase() {
    try {
        const client = await pool.connect();
        try {
            // Create bricks table if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS bricks (
                    id INTEGER PRIMARY KEY,
                    count INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // Create brick_logs table if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS brick_logs (
                    id SERIAL PRIMARY KEY,
                    logged_at TIMESTAMP DEFAULT NOW(),
                    count INTEGER NOT NULL
                )
            `);

            // Create ip_logs table if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS ip_logs (
                    id SERIAL PRIMARY KEY,
                    ip_address VARCHAR(45) NOT NULL,
                    otp_attempted VARCHAR(10),
                    success BOOLEAN NOT NULL,
                    endpoint VARCHAR(50),
                    attempted_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // Create index on ip_logs for better query performance
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_ip_logs_ip_time 
                ON ip_logs(ip_address, attempted_at)
            `);

            // Initialize the brick count if it doesn't exist
            await client.query(`
                INSERT INTO bricks (id, count) VALUES (1, 0)
                ON CONFLICT (id) DO NOTHING
            `);

            console.log('Database initialized successfully');
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error initializing database:', error);
        process.exit(1);
    }
}

// Start The Server
async function main() {
    console.log('Initializing database...');
    await initializeDatabase();

    console.log('Starting Server');
    startServer();
    startCLI();

    // Set up periodic brick logging
    setInterval(SaveBricks, 5 * 60 * 1000);
    // Clear Cache
    setInterval(CleanupCache, 5 * 60 * 1000);
    setInterval(cleanupExpiredFailures, IP_BLOCK_CONFIG.cleanupIntervalMinutes * 60 * 1000);
    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
}

main().catch(console.error);