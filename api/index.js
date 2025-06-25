const md5 = require("md5");
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const otpkey = process.env.OTP_KEY;
const interval = 10;

// Cache objects with TTL
const cache = {
    bricks: { value: null, expires: 0 },
    otp: { value: null, counter: null, expires: 0 }
};

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

function CheckOTP(otp) {
    let counter = CalculateCounter();
    let currentOTP = CalculateOTP(counter);
    let prevOTP = CalculateOTP(counter - 1);
    return (otp == currentOTP) || (otp == prevOTP);
}

function SuccessResponseBricks(bricks, res) {
    res.status(200).send(bricks.toString());
}

function SuccessResponseTime(res) {
    const d = new Date();
    let time = d.getTime();
    res.status(200).send(time.toString());
}

function FailureResponse(res) {
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

async function incrementBricks() {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(`
                INSERT INTO bricks (id, count) VALUES (1, 1)
                    ON CONFLICT (id) DO UPDATE SET count = bricks.count + 1, updated_at = NOW()
                                            RETURNING count
            `);

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

// Main handler for Vercel
export default async function handler(req, res) {
    const { method, query } = req;

    // Enable CORS if needed
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        if (query.place && query.id) {
            // Handle /place/:id route - place bricks
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

            if (CheckOTP(query.id)) {
                const newBricks = await incrementBricks();
                console.log(`Placed Brick ${newBricks} on ID: ${query.id}`);
                SuccessResponseBricks(newBricks, res);
            } else {
                console.log(`Error: Incorrect otp: ${query.id}`);
                FailureResponse(res);
            }
        } else if (query.time) {
            SuccessResponseTime(res);
        }
        else {
            // Handle root route - show current bricks
            res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

            const currentBricks = await getBricks();
            SuccessResponseBricks(currentBricks, res);
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal server error');
    }
}