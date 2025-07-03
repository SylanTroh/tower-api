const express = require('express');
const rateLimit = require('express-rate-limit');
const md5 = require("md5");
const readline = require('readline');
const { Pool } = require('pg');
const env = require('dotenv').config();

const app = express();

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT,
    password: process.env.PGPASSWORD, // optional if using peer auth
});

// Environment variables
const otpkey = process.env.OTP_KEY;
const interval = 10;

if (!otpkey) {
    console.error('OTP_KEY environment variable is required');
    process.exit(1);
}

// General rate limiter
const generalLimiter = rateLimit({
    windowMs: 15 * 1000,
    max: 4, // Limit each IP to 4 requests per 15 seconds
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 seconds'
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip;
    }
});

// Apply general rate limiting to all routes
app.use(generalLimiter);

// Cache objects with TTL
const cache = {
    bricks: { value: null, expires: 0 },
    otp: { value: null, counter: null, expires: 0 }
};

function MD5Hash(str) {
    const hash = md5(str);
    return hash;
}

function CalculateCounter(){
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

function FailureResponse(res,req){
    console.log(`Error: Incorrect otp: ${req.params.id}`);
    res.status(400).send("<p>Hi! This is Sylan!<br>" +
        "If you're here, that means you're poking around at the server for my tower world.<br>" +
        "It's pretty cool that you've managed to get here, I myself love to tinker around with things and figure out how they work, but I would like to please ask you to consider the following before poking any further:<br>" +
        "I made this world because I wanted to make a fun experience that brings people together.<br>" +
        "To accomplish this, I pay for the server that makes this possible out of pocket, and I am more than willing to do so because it makes me happy to see others having fun.<br>" +
        "I don't make any money from this world. This means that if bots or users outside VR decide to flood the server with requests, I will likely not be able to afford to keep it running anymore, shutting it down for everyone.<br>" +
        "While I can't possibly know your intentions, I hope you can keep that in mind if you decide to continue poking around here.<br>" +
        "<br>" +
        "- Sylan</p>");
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
        FailureResponse(res, req);
    }
});

//Show Server Time
app.get('/time', (req, res) => {
    SuccessResponseTime(res,req);
});

//Add One Brick
app.get('/place/:id', async (req, res) => {
    if(CheckOTP(req.params.id)) {
        await PlaceBrick(1, res, req);
    } else {
        FailureResponse(res, req);
    }
});

//Add Two Bricks
app.get('/place2/:id', async (req, res) => {
    if(CheckOTP(req.params.id)) {
        await PlaceBrick(2, res, req);
    } else {
        FailureResponse(res, req);
    }
});

//Add Three Bricks
app.get('/place3/:id', async (req, res) => {
    if(CheckOTP(req.params.id)) {
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
    const saveInterval = setInterval(SaveBricks, 5 * 60 * 1000);

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        clearInterval(saveInterval);
        pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
}

main().catch(console.error);